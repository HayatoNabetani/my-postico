fn main() {
    generate_icon();
    tauri_build::build()
}

fn generate_icon() {
    const SIZE: u32 = 512;
    let mut pixels = vec![0_u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let index = ((y * SIZE + x) * 4) as usize;
            let rounded = inside_rounded_rect(x as f32, y as f32, 0.0, 0.0, 512.0, 512.0, 112.0);
            let mut color = if rounded { [21, 23, 28, 255] } else { [0, 0, 0, 0] };
            let ellipse = (((x as f32 - 256.0) / 142.0).powi(2) + ((y as f32 - 152.0) / 63.0).powi(2)) <= 1.0;
            if ellipse {
                let t = (x + y).min(1024) as f32 / 1024.0;
                color = mix([195, 169, 255, 255], [116, 80, 218, 255], t);
            }
            if x >= 114 && x <= 398 && y >= 152 && y <= 423 {
                let band = if y < 270 { [154, 120, 236, 255] } else { [116, 80, 218, 255] };
                let phase = ((y - 152) % 118) as f32;
                let width = 142.0 * (1.0 - ((phase - 59.0) / 63.0).powi(2)).max(0.0).sqrt();
                if (x as f32 - 256.0).abs() <= width { color = band; }
            }
            pixels[index..index + 4].copy_from_slice(&color);
        }
    }
    let path = std::path::Path::new("icons/icon.png");
    std::fs::create_dir_all("icons").expect("create icon directory");
    let file = std::fs::File::create(path).expect("create app icon");
    let mut encoder = png::Encoder::new(file, SIZE, SIZE);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().expect("write icon header").write_image_data(&pixels).expect("write app icon");
}

fn mix(a: [u8; 4], b: [u8; 4], t: f32) -> [u8; 4] {
    [0, 1, 2, 3].map(|i| (a[i] as f32 * (1.0 - t) + b[i] as f32 * t) as u8)
}

fn inside_rounded_rect(x: f32, y: f32, left: f32, top: f32, width: f32, height: f32, radius: f32) -> bool {
    let nearest_x = x.clamp(left + radius, left + width - radius);
    let nearest_y = y.clamp(top + radius, top + height - radius);
    (x - nearest_x).powi(2) + (y - nearest_y).powi(2) <= radius.powi(2)
}
