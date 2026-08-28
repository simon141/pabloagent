use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::remote;
use crate::AppState;

fn watch_interval(suspended_for: Duration) -> Duration {
    if suspended_for < Duration::from_secs(60) {
        Duration::from_secs(3)
    } else if suspended_for < Duration::from_secs(300) {
        Duration::from_secs(15)
    } else {
        Duration::from_secs(30)
    }
}
const WATCH_FAILURE_GRACE: Duration = Duration::from_secs(600);
const STATUS_ONLY: u64 = 999_999_999;
const TURN_FINISHED_NOTIFICATION_ID: i32 = 42;
const TURN_FINISHED_TITLE: &str = "Pablo is ready";
const TURN_FINISHED_BODY: &str = "Tap to open.";

#[derive(Default)]
pub struct TurnWatch {
    watched: Mutex<HashSet<String>>,
    suspended: AtomicBool,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    tray: Mutex<()>,
    service_on: AtomicBool,
}

#[tauri::command]
pub fn watch_turn(app: AppHandle, state: State<'_, AppState>, key: String) -> Result<(), String> {
    // Catches the resume that never arrived as an event, a cold launch, or a
    // device that recreated the activity rather than resuming it.
    clear_finished_notification(&app);
    if let Err(err) = start_service(state.inner()) {
        return Err(format!("Could not start background turn monitoring: {err}"));
    }
    state.watch.watched.lock().unwrap().insert(key);
    // The activity can pause while this command crosses the WebView bridge;
    // if the lifecycle event missed the not-yet-registered turn, take native
    // polling over here.
    if state.watch.suspended.load(Ordering::SeqCst) {
        start_task(&app, &state);
    }
    Ok(())
}

#[tauri::command]
pub fn reset_watch(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    clear_finished_notification(&app);
    let stale: Vec<String> = state.watch.watched.lock().unwrap().drain().collect();
    abort_task(&state);
    stop_service(&state, "frontend rebuilt")
        .map_err(|err| format!("Could not stop stale background turn monitoring: {err}"))?;
    for key in stale {
        state.diagnostics.push(
            "watch",
            format!("frontend rebuilt; released stale watch {key}"),
        );
    }
    Ok(())
}

pub fn turn_ended(app: &AppHandle, key: &str) {
    let state = app.state::<AppState>();
    if !state.watch.watched.lock().unwrap().remove(key) {
        return;
    }
    if state.watch.suspended.load(Ordering::SeqCst) {
        notify_finished(app);
    }
    if state.watch.watched.lock().unwrap().is_empty() {
        // Safe from inside the watcher itself: cancellation lands at the next
        // await point.
        abort_task(&state);
        let _ = stop_service(&state, "every watched turn has ended");
    }
}

#[cfg_attr(desktop, allow(dead_code))]
pub fn on_suspended(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.watch.suspended.store(true, Ordering::SeqCst);
    let watching = state.watch.watched.lock().unwrap().len();
    if watching == 0 {
        return;
    }
    // The service can already be down here, and a backgrounded app is not
    // allowed to raise it again; polling proceeds unprotected as best effort.
    if !state.watch.service_on.load(Ordering::SeqCst) {
        state.diagnostics.push(
            "watch",
            format!("suspending with {watching} watched turn(s) but no foreground service; polling is unprotected until the next resume"),
        );
    }
    start_task(app, &state);
}

#[cfg_attr(desktop, allow(dead_code))]
pub fn on_resumed(app: &AppHandle) {
    let state = app.state::<AppState>();
    // Before the clear is queued, so a post still waiting on `tray` re-reads
    // this and stands down rather than being cleared a moment too late.
    state.watch.suspended.store(false, Ordering::SeqCst);
    clear_finished_notification(app);
    if abort_task(&state) {
        state
            .diagnostics
            .push("watch", "app resumed; the webview takes the polling back");
    }
    // Android 15 ends a dataSync service when its daily time budget runs out;
    // Kotlin records that, and reading it here keeps diagnostics honest.
    if service::consume_timeout() {
        state.watch.service_on.store(false, Ordering::SeqCst);
        state.diagnostics.push(
            "watch",
            "Android ended the turn service: its dataSync time budget ran out",
        );
    }
    let watching = !state.watch.watched.lock().unwrap().is_empty();
    if watching && !state.watch.service_on.load(Ordering::SeqCst) {
        // A failed start has already pushed its reason to diagnostics.
        if start_service(&state).is_ok() {
            state.diagnostics.push(
                "watch",
                "re-asserted the turn service for a surviving watch",
            );
        }
    }
}

fn start_service(state: &AppState) -> Result<(), String> {
    match service::set_active(true, state) {
        Ok(()) => {
            state.watch.service_on.store(true, Ordering::SeqCst);
            Ok(())
        }
        Err(err) => {
            let _ = stop_service(state, "start failed");
            Err(err)
        }
    }
}

fn stop_service(state: &AppState, reason: &str) -> Result<(), String> {
    if state.watch.service_on.swap(false, Ordering::SeqCst) {
        state
            .diagnostics
            .push("watch", format!("turn service stopped: {reason}"));
    }
    service::set_active(false, state)
}

fn abort_task(state: &AppState) -> bool {
    match state.watch.task.lock().unwrap().take() {
        Some(task) => {
            task.abort();
            true
        }
        None => false,
    }
}

fn start_task(app: &AppHandle, state: &AppState) {
    state
        .diagnostics
        .push("watch", "app suspended; watched turns are polled natively");
    let mut slot = state.watch.task.lock().unwrap();
    if let Some(task) = slot.take() {
        task.abort();
    }
    *slot = Some(tauri::async_runtime::spawn(watch_until_done(app.clone())));
}

async fn watch_until_done(app: AppHandle) {
    let state = app.state::<AppState>();
    let started = tokio::time::Instant::now();
    // The count rides along purely for the diagnostics lines.
    let mut failing_since: Option<tokio::time::Instant> = None;
    let mut failures: u32 = 0;
    loop {
        tokio::time::sleep(watch_interval(started.elapsed())).await;
        if !state.watch.suspended.load(Ordering::SeqCst) {
            return;
        }
        // A fresh snapshot each round, so a watch registered or retired during
        // the stay is picked up without restarting the task.
        let keys: Vec<String> = state
            .watch
            .watched
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect();
        if keys.is_empty() {
            return;
        }
        let mut round_failed = false;
        for key in keys {
            // The webview may have retired the watch itself while this round
            // was underway (not every device pauses its JavaScript).
            if !state.watch.watched.lock().unwrap().contains(&key) {
                continue;
            }
            let output = {
                let mut guard = state.connection.lock().await;
                let Some(connection) = guard.as_mut() else {
                    return;
                };
                connection
                    .run_ok("watch turn", &remote::poll_turn_command(&key, STATUS_ONLY))
                    .await
            };
            match output.and_then(|out| remote::parse_turn_poll(&out)) {
                Ok(poll) => {
                    if !poll.running {
                        turn_ended(&app, &key);
                    }
                }
                Err(err) => {
                    round_failed = true;
                    failures += 1;
                    state
                        .diagnostics
                        .push("watch", format!("background poll {failures} failed: {err}"));
                }
            }
        }
        if !round_failed {
            failing_since = None;
            failures = 0;
            continue;
        }
        let since = *failing_since.get_or_insert_with(tokio::time::Instant::now);
        if since.elapsed() >= WATCH_FAILURE_GRACE {
            // Under Doze this is the expected shape, not a fault. Every watch
            // stays registered: the next resume re-asserts the service and the
            // webview reconciles from its cursor.
            state.diagnostics.push(
                "watch",
                "giving up on the background watch; the webview will catch up on resume",
            );
            let _ = stop_service(&state, "background polling kept failing");
            return;
        }
    }
}

fn notify_finished(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _tray = state.watch.tray.lock().unwrap();
    if !state.watch.suspended.load(Ordering::SeqCst) {
        state.diagnostics.push(
            "watch",
            "the turn ended as the app came back; nothing to notify about",
        );
        return;
    }
    // The icon is set per notification: tauri-plugin-notification 2.3.3 has no
    // Rust-side config struct, so a `plugins.notification` block in
    // tauri.conf.json fails deserialization and panics the app at startup.
    let builder = app
        .notification()
        .builder()
        .id(TURN_FINISHED_NOTIFICATION_ID)
        // Android leaves a tapped notification in the tray otherwise, and the
        // clear on resume cannot help: the tap resumes the activity first.
        .auto_cancel()
        .title(TURN_FINISHED_TITLE)
        .body(TURN_FINISHED_BODY);
    #[cfg(target_os = "android")]
    let builder = builder.icon("ic_stat_pablo");
    match builder.show() {
        Ok(()) => state.diagnostics.push(
            "watch",
            format!("posted notification: {TURN_FINISHED_TITLE}"),
        ),
        Err(err) => state
            .diagnostics
            .push("watch", format!("could not post notification: {err}")),
    }
}

pub fn clear_finished_notification(app: &AppHandle) {
    #[cfg(mobile)]
    {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let _tray = state.watch.tray.lock().unwrap();
            if let Err(err) = app.notification().remove_all_active() {
                state
                    .diagnostics
                    .push("watch", format!("could not clear notifications: {err}"));
            }
        });
    }
    #[cfg(desktop)]
    let _ = app;
}

mod service {
    use crate::AppState;

    #[cfg(target_os = "android")]
    pub fn set_active(active: bool, state: &AppState) -> Result<(), String> {
        match call(active) {
            Ok(()) => Ok(()),
            Err(err) => {
                state.diagnostics.push(
                    "watch",
                    format!(
                        "turn service {} failed: {err}",
                        if active { "start" } else { "stop" }
                    ),
                );
                Err(err)
            }
        }
    }

    #[cfg(not(target_os = "android"))]
    pub fn set_active(_active: bool, _state: &AppState) -> Result<(), String> {
        Ok(())
    }

    #[cfg(target_os = "android")]
    pub fn consume_timeout() -> bool {
        query_timeout().unwrap_or(false)
    }

    #[cfg(not(target_os = "android"))]
    pub fn consume_timeout() -> bool {
        false
    }

    #[cfg(target_os = "android")]
    fn call(active: bool) -> Result<(), String> {
        use jni::objects::{JClass, JObject, JValue};

        let ctx = tao::platform::android::prelude::main_android_context()
            .ok_or("no Android context yet")?;
        let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let activity = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };

        let result = (|| -> jni::errors::Result<()> {
            let class = load_service_class(&mut env, &activity)?;
            env.call_static_method(
                JClass::from(class),
                "setActive",
                "(Landroid/content/Context;Z)V",
                &[JValue::Object(&activity), JValue::Bool(active.into())],
            )?;
            Ok(())
        })();

        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err("Android threw while switching the turn service".into());
        }
        result.map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn query_timeout() -> Result<bool, String> {
        use jni::objects::{JClass, JObject};

        let ctx = tao::platform::android::prelude::main_android_context()
            .ok_or("no Android context yet")?;
        let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let activity = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };

        let result = (|| -> jni::errors::Result<bool> {
            let class = load_service_class(&mut env, &activity)?;
            env.call_static_method(JClass::from(class), "consumeTimeout", "()Z", &[])?
                .z()
        })();

        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err("Android threw while reading the turn service state".into());
        }
        result.map_err(|e| e.to_string())
    }

    #[cfg(target_os = "android")]
    fn load_service_class<'a>(
        env: &mut jni::JNIEnv<'a>,
        activity: &jni::objects::JObject<'a>,
    ) -> jni::errors::Result<jni::objects::JObject<'a>> {
        use jni::objects::{JObject, JValue};

        let loader = env
            .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let name = env.new_string("app.pabloagent.TurnService")?;
        env.call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&JObject::from(name))],
        )?
        .l()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_finished_notification_has_one_id_of_its_own() {
        const TURN_SERVICE_NOTIFICATION_ID: i32 = 41;
        assert_ne!(TURN_FINISHED_NOTIFICATION_ID, TURN_SERVICE_NOTIFICATION_ID);
    }

    #[test]
    fn watch_interval_backs_off_with_the_stay() {
        assert_eq!(watch_interval(Duration::ZERO), Duration::from_secs(3));
        assert_eq!(
            watch_interval(Duration::from_secs(59)),
            Duration::from_secs(3)
        );
        assert_eq!(
            watch_interval(Duration::from_secs(60)),
            Duration::from_secs(15)
        );
        assert_eq!(
            watch_interval(Duration::from_secs(299)),
            Duration::from_secs(15)
        );
        assert_eq!(
            watch_interval(Duration::from_secs(300)),
            Duration::from_secs(30)
        );
        assert_eq!(
            watch_interval(Duration::from_secs(3600)),
            Duration::from_secs(30)
        );
    }
}
