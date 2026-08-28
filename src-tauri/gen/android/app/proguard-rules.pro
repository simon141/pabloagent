-keep class app.pabloagent.** { *; }
-keep class app.tauri.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
