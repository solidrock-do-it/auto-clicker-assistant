use tauri::{AppHandle, Emitter, Manager, State};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use enigo::{Enigo, Settings, Mouse, Keyboard, Button, Direction, Coordinate, Axis};
use rand::Rng;
use chrono::Local;

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct Area {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct ClickConfig {
    area: Area,
    interval: u64, // minutes
    enable_scroll: bool,
    scroll_interval: u32,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
struct ClickEvent {
    time: String,
    x: i32,
    y: i32,
    count: u32,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
struct ScrollEvent {
    direction: String,
    time: String,
}

struct AppState {
    running: Arc<AtomicBool>,
}

#[tauri::command]
fn get_mouse_position() -> (i32, i32) {
    let enigo = Enigo::new(&Settings::default()).unwrap();
    enigo.location().unwrap()
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> bool {
    state.running.load(Ordering::SeqCst)
}

#[tauri::command]
fn stop_clicking(state: State<'_, AppState>) {
    state.running.store(false, Ordering::SeqCst);
}

#[tauri::command]
async fn start_clicking(
    app: AppHandle,
    state: State<'_, AppState>,
    config: ClickConfig,
) -> Result<(), String> {
    if state.running.load(Ordering::SeqCst) {
        return Err("Already running".into());
    }

    state.running.store(true, Ordering::SeqCst);
    let running = state.running.clone();
    
    // Spawn thread
    thread::spawn(move || {
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        let mut rng = rand::thread_rng();
        let mut click_count = 0;
        let mut clicks_since_scroll = 0;

        // Ensure correct order of coordinates
        let x_start = std::cmp::min(config.area.x1, config.area.x2);
        let x_end = std::cmp::max(config.area.x1, config.area.x2);
        let y_start = std::cmp::min(config.area.y1, config.area.y2);
        let y_end = std::cmp::max(config.area.y1, config.area.y2);

        let area_height = y_end - y_start;
        // avoid division by zero
        let num_rows = std::cmp::max(1, area_height / 40);

        while running.load(Ordering::SeqCst) {
            
             // 1. Scroll Check
            if config.enable_scroll && clicks_since_scroll >= config.scroll_interval {
                 let center_x = (x_start + x_end) / 2;
                 let center_y = (y_start + y_end) / 2;
                 
                 enigo.move_mouse(center_x, center_y, Coordinate::Abs).ok();
                 thread::sleep(Duration::from_millis(300));
                 
                 // 50% chance up or down
                 let direction_sign = if rng.gen_bool(0.5) { 1 } else { -1 }; 
                 
                 enigo.scroll(direction_sign * 3, Axis::Vertical).ok();
                 
                 app.emit("scroll-event", ScrollEvent {
                     direction: if direction_sign > 0 { "Up".to_string() } else { "Down".to_string() },
                     time: Local::now().format("%H:%M:%S").to_string()
                 }).ok();
                 
                 clicks_since_scroll = 0;
                 thread::sleep(Duration::from_millis(300));
            }
            
            // 2. Determine Click Position
            let row_idx = rng.gen_range(0..num_rows);
            let row_y_base = y_start + row_idx * 40;
            
            let width = x_end - x_start;
            let x_margin = width / 6; 
            let x_min = x_start + x_margin;
            let x_max = x_end - x_margin;
            
            // Handle edge case where margin is too large or negative (small width)
            let (target_x, target_y) = if x_max > x_min {
                let tx = rng.gen_range(x_min..=x_max);
                
                let row_height = 40;
                let y_margin = row_height / 3;
                let y_min_r = row_y_base + y_margin;
                let y_max_r = row_y_base + row_height - y_margin;
                
                let ty = if y_max_r > y_min_r {
                    rng.gen_range(y_min_r..=y_max_r)
                } else {
                    row_y_base + row_height / 2
                };
                (tx, ty)
            } else {
                 // Fallback to center
                 ((x_start + x_end) / 2, row_y_base + 20)
            };

            // 3. Move and Click
            enigo.move_mouse(target_x, target_y, Coordinate::Abs).ok();
            thread::sleep(Duration::from_millis(100)); 
            enigo.button(Button::Left, Direction::Click).ok();
            
            click_count += 1;
            clicks_since_scroll += 1;
            
            app.emit("click-event", ClickEvent {
                time: Local::now().format("%H:%M:%S").to_string(),
                x: target_x,
                y: target_y,
                count: click_count
            }).ok();
            
            // 4. Wait Interval
            // Convert Minutes to Seconds
            let sleep_secs = config.interval * 60;
            
            // Check every 100ms
            let sleep_steps = sleep_secs * 10; 
            for _ in 0..sleep_steps {
                if !running.load(Ordering::SeqCst) { break; }
                thread::sleep(Duration::from_millis(100));
            }
        }
        
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            running: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_mouse_position,
            start_clicking,
            stop_clicking,
            get_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
