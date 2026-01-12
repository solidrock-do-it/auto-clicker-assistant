use tauri::{AppHandle, Emitter, State};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use enigo::{Enigo, Settings, Mouse, Button, Direction, Coordinate, Axis};
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
    scroll_amount: i32, // scroll distance in units
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

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
struct BackendLog {
    level: String,
    message: String,
    time: String,
}

struct AppState {
    running: Arc<AtomicBool>,
    keep_awake: Arc<AtomicBool>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
struct SystemCheckResult {
    screen_timeout: Option<u32>,      // minutes, None = Never
    screensaver_enabled: bool,
    screensaver_secured: bool,
    sleep_timeout: Option<u32>,       // minutes, None = Never
    warnings: Vec<String>,
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
fn check_privileges() -> String {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token: HANDLE = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_ok() {
                let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
                let mut return_length = 0u32;
                if GetTokenInformation(
                    token,
                    TokenElevation,
                    Some(&mut elevation as *mut _ as *mut _),
                    std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                    &mut return_length,
                )
                .is_ok()
                {
                    if elevation.TokenIsElevated != 0 {
                        return "管理员权限 ✓".to_string();
                    } else {
                        return "普通权限 (可能无法点击管理员应用)".to_string();
                    }
                }
            }
        }
        "权限检查失败".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "仅支持 Windows".to_string()
    }
}

#[tauri::command]
fn relaunch_as_admin(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        let exe = std::env::current_exe().map_err(|e| format!("获取程序路径失败: {}", e))?;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| "程序路径包含无法识别的字符".to_string())?
            .to_string();

        // 通过 PowerShell 触发 UAC 提权启动（用户会看到系统弹窗，无法静默提权）
        // -WindowStyle Hidden: 不弹出额外的 PowerShell 窗口
        // -Verb RunAs: 以管理员身份运行
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &format!(
                    "Start-Process -FilePath '{}' -Verb RunAs",
                    exe_str.replace("'", "''")
                ),
            ])
            .spawn()
            .map_err(|e| format!("提权启动失败: {}", e))?;

        // 退出当前非管理员实例
        app.exit(0);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("此功能仅支持 Windows".to_string())
    }
}

#[tauri::command]
fn test_click_here() -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("{:?}", e))?;
    let (x, y) = enigo.location().map_err(|e| format!("{:?}", e))?;
    
    // Try clicking at current position
    enigo
        .button(Button::Left, Direction::Press)
        .map_err(|e| format!("Press失败: {:?}", e))?;
    thread::sleep(Duration::from_millis(50));
    enigo
        .button(Button::Left, Direction::Release)
        .map_err(|e| format!("Release失败: {:?}", e))?;
    
    Ok(format!("测试点击成功 at ({}, {})", x, y))
}

#[tauri::command]
fn check_system_settings() -> SystemCheckResult {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Registry::{RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_VALUE_TYPE};
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::ERROR_SUCCESS;

        let mut warnings = Vec::new();
        let mut screen_timeout = None;
        let mut screensaver_enabled = false;
        let mut screensaver_secured = false;
        let sleep_timeout = None;

        unsafe {
            // Check screen timeout
            let desktop_key = "Control Panel\\Desktop\0".encode_utf16().collect::<Vec<u16>>();
            let mut hkey: HKEY = HKEY::default();
            if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(desktop_key.as_ptr()), 0, KEY_READ, &mut hkey) == ERROR_SUCCESS {
                // Check screensaver
                let mut buffer = [0u16; 256];
                let mut buffer_size = (buffer.len() * 2) as u32;
                let mut reg_type = REG_VALUE_TYPE(0);
                
                let ss_active = "ScreenSaveActive\0".encode_utf16().collect::<Vec<u16>>();
                if RegQueryValueExW(hkey, PCWSTR(ss_active.as_ptr()), None, Some(&mut reg_type), Some(buffer.as_mut_ptr() as *mut u8), Some(&mut buffer_size)) == ERROR_SUCCESS {
                    let value = String::from_utf16_lossy(&buffer[..buffer_size as usize / 2 - 1]);
                    screensaver_enabled = value == "1";
                }

                // Check screensaver password
                let ss_secure = "ScreenSaverIsSecure\0".encode_utf16().collect::<Vec<u16>>();
                buffer_size = (buffer.len() * 2) as u32;
                if RegQueryValueExW(hkey, PCWSTR(ss_secure.as_ptr()), None, Some(&mut reg_type), Some(buffer.as_mut_ptr() as *mut u8), Some(&mut buffer_size)) == ERROR_SUCCESS {
                    let value = String::from_utf16_lossy(&buffer[..buffer_size as usize / 2 - 1]);
                    screensaver_secured = value == "1";
                }

                // Check screen timeout
                let timeout_val = "ScreenSaveTimeOut\0".encode_utf16().collect::<Vec<u16>>();
                buffer_size = (buffer.len() * 2) as u32;
                if RegQueryValueExW(hkey, PCWSTR(timeout_val.as_ptr()), None, Some(&mut reg_type), Some(buffer.as_mut_ptr() as *mut u8), Some(&mut buffer_size)) == ERROR_SUCCESS {
                    let value = String::from_utf16_lossy(&buffer[..buffer_size as usize / 2 - 1]);
                    if let Ok(seconds) = value.parse::<u32>() {
                        if seconds > 0 {
                            screen_timeout = Some(seconds / 60);
                        }
                    }
                }
            }
        }

        // Generate warnings
        if screensaver_enabled {
            warnings.push("屏幕保护程序已启用".to_string());
        }
        if screensaver_secured {
            warnings.push("屏保需要密码 - 会导致锁屏".to_string());
        }
        if let Some(timeout) = screen_timeout {
            if timeout > 0 && timeout < 999 {
                warnings.push(format!("屏幕将在 {} 分钟后超时", timeout));
            }
        }

        return SystemCheckResult {
            screen_timeout,
            screensaver_enabled,
            screensaver_secured,
            sleep_timeout,
            warnings,
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        SystemCheckResult {
            screen_timeout: None,
            screensaver_enabled: false,
            screensaver_secured: false,
            sleep_timeout: None,
            warnings: vec!["此功能仅支持 Windows".to_string()],
        }
    }
}

#[tauri::command]
fn set_keep_awake(state: State<'_, AppState>, enable: bool) -> Result<String, String> {
    state.keep_awake.store(enable, Ordering::SeqCst);
    
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, EXECUTION_STATE};
        
        unsafe {
            if enable {
                // Prevent system sleep and display timeout
                let flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED;
                SetThreadExecutionState(EXECUTION_STATE(flags.0));
                Ok("系统保持活跃模式已启用 ✓".to_string())
            } else {
                // Allow system to sleep normally
                SetThreadExecutionState(ES_CONTINUOUS);
                Ok("系统保持活跃模式已关闭".to_string())
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if enable {
            Ok("保持活跃功能仅支持 Windows".to_string())
        } else {
            Ok("已关闭".to_string())
        }
    }
}

#[tauri::command]
fn open_power_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(&["/C", "start", "ms-settings:powersleep"])
            .spawn()
            .map_err(|e| format!("打开设置失败: {}", e))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows".to_string())
    }
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

        fn human_move_mouse(
            enigo: &mut Enigo,
            rng: &mut rand::rngs::ThreadRng,
            tx: i32,
            ty: i32,
        ) {
            let (sx, sy) = match enigo.location() {
                Ok(p) => p,
                Err(_) => (tx, ty),
            };

            let dx = (tx - sx) as f32;
            let dy = (ty - sy) as f32;
            let dist = (dx * dx + dy * dy).sqrt();

            // steps roughly proportional to distance, clamped
            let steps = ((dist / 25.0).round() as i32).clamp(8, 28);
            for i in 1..=steps {
                let t = i as f32 / steps as f32;
                // smoothstep ease-in-out
                let eased = t * t * (3.0 - 2.0 * t);

                // subtle hand jitter
                let jx: i32 = rng.gen_range(-1..=1);
                let jy: i32 = rng.gen_range(-1..=1);

                let x = sx as f32 + dx * eased;
                let y = sy as f32 + dy * eased;

                let _ = enigo.move_mouse(x.round() as i32 + jx, y.round() as i32 + jy, Coordinate::Abs);
                thread::sleep(Duration::from_millis(rng.gen_range(6..=16)));
            }

            // settle
            let _ = enigo.move_mouse(tx, ty, Coordinate::Abs);
            thread::sleep(Duration::from_millis(rng.gen_range(60..=140)));
        }

        // Ensure correct order of coordinates
        let x_start = std::cmp::min(config.area.x1, config.area.x2);
        let x_end = std::cmp::max(config.area.x1, config.area.x2);
        let y_start = std::cmp::min(config.area.y1, config.area.y2);
        let y_end = std::cmp::max(config.area.y1, config.area.y2);

        while running.load(Ordering::SeqCst) {
            
             // 1. Scroll Check
            if config.enable_scroll && clicks_since_scroll >= config.scroll_interval {
                 let center_x = (x_start + x_end) / 2;
                 let center_y = (y_start + y_end) / 2;
                 
                 enigo.move_mouse(center_x, center_y, Coordinate::Abs).ok();
                 thread::sleep(Duration::from_millis(300));
                 
                 // 50% chance up or down
                 let direction_sign = if rng.gen_bool(0.5) { 1 } else { -1 }; 
                 
                 enigo.scroll(direction_sign * config.scroll_amount, Axis::Vertical).ok();
                 
                 app.emit("scroll-event", ScrollEvent {
                     direction: if direction_sign > 0 { "Up".to_string() } else { "Down".to_string() },
                     time: Local::now().format("%H:%M:%S").to_string()
                 }).ok();
                 
                 clicks_since_scroll = 0;
                 thread::sleep(Duration::from_millis(300));
            }
            
            // 2. Determine Click Position (PRD策略)
            // - 按可见区域高度计算行数（每行约 40 像素）
            // - 随机选择某一行
            // - X 取列表宽度中间 2/3
            // - Y 取行高中间 1/3
            let row_height: i32 = 40;
            let height = y_end - y_start;
            let num_rows = std::cmp::max(1, height / row_height);

            let row_idx = rng.gen_range(0..num_rows);
            let row_top = y_start + row_idx * row_height;
            let row_bottom = std::cmp::min(row_top + row_height, y_end);

            let width = x_end - x_start;
            let x_margin = width / 6;
            let x_min = x_start + x_margin;
            let x_max = x_end - x_margin;

            let target_x = if x_max > x_min {
                rng.gen_range(x_min..x_max)
            } else {
                (x_start + x_end) / 2
            };

            let row_span = row_bottom - row_top;
            let y_margin = row_span / 3;
            let y_min = row_top + y_margin;
            let y_max = row_bottom - y_margin;
            let target_y = if y_max > y_min {
                rng.gen_range(y_min..y_max)
            } else {
                row_top + row_span / 2
            };

            // 3. Move and Click (simulate human)
            // 3.1 Move with easing + jitter, then settle
            human_move_mouse(&mut enigo, &mut rng, target_x, target_y);

            // 3.2 Press / hold / release (some apps ignore ultra-fast injected clicks)
            let press_ok = match enigo.button(Button::Left, Direction::Press) {
                Ok(_) => true,
                Err(e) => {
                    app.emit(
                        "backend-log",
                        BackendLog {
                            level: "error".to_string(),
                            message: format!("press failed: {:?}", e),
                            time: Local::now().format("%H:%M:%S").to_string(),
                        },
                    )
                    .ok();
                    false
                }
            };

            // hold time
            thread::sleep(Duration::from_millis(rng.gen_range(80..=220)));

            let release_ok = match enigo.button(Button::Left, Direction::Release) {
                Ok(_) => true,
                Err(e) => {
                    app.emit(
                        "backend-log",
                        BackendLog {
                            level: "error".to_string(),
                            message: format!("release failed: {:?}", e),
                            time: Local::now().format("%H:%M:%S").to_string(),
                        },
                    )
                    .ok();
                    false
                }
            };

            let click_ok = press_ok && release_ok;
            
            click_count += 1;
            clicks_since_scroll += 1;
            
            if click_ok {
                app.emit(
                    "click-event",
                    ClickEvent {
                        time: Local::now().format("%H:%M:%S").to_string(),
                        x: target_x,
                        y: target_y,
                        count: click_count,
                    },
                )
                .ok();
            }
            
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
            keep_awake: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_mouse_position,
            start_clicking,
            stop_clicking,
            get_status,
            check_privileges,
            test_click_here,
            check_system_settings,
            set_keep_awake,
            open_power_settings,
            relaunch_as_admin
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
