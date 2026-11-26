fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/macos_usb.c");
        println!("cargo:rerun-if-changed=src/macos_window.m");
        cc::Build::new()
            .file("src/macos_usb.c")
            .compile("macos_usb");
        cc::Build::new()
            .file("src/macos_window.m")
            .flag("-fobjc-arc")
            .compile("macos_window");
        println!("cargo:rustc-link-lib=framework=IOKit");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
    tauri_build::build()
}
