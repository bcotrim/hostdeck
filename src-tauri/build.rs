fn main() {
    println!("cargo:rerun-if-changed=native/helper.m");
    cc::Build::new()
        .file("native/helper.m")
        .flag("-fobjc-arc")
        .flag("-fblocks")
        .flag("-mmacosx-version-min=13.0")
        .compile("hostdeck_helper");
    for framework in ["Foundation", "Security", "ServiceManagement"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    tauri_build::build()
}
