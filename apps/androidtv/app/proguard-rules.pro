# OkHttp / kotlinx.serialization
-dontwarn okhttp3.**
-dontwarn okio.**
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class org.librextv.tv.**$$serializer { *; }
-keepclassmembers class org.librextv.tv.** {
    *** Companion;
}
