# Add project specific ProGuard rules here.
# Add any project specific keep options here:

# Keep React Native classes
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }

# Keep WebRTC
-keep class org.webrtc.** { *; }
-keep class com.oney.WebRTCModule.** { *; }

# Keep Foreground Service
-keep class com.supersami.foregroundservice.** { *; }

# Keep socket.io
-keep class io.socket.** { *; }

# Suppress warnings
-dontwarn com.facebook.react.**
-dontwarn org.webrtc.**
