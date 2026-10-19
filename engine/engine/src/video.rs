//! Frames from the core.
//!
//! `video_refresh` copies the core's rows into one tightly packed buffer in
//! the core's own pixel format (a straight row copy). Conversion to RGBA8
//! happens only when something needs it (a PNG, a thumbnail, the RGBA path to
//! the page); RGB565 stays 16-bit on the wire and the page's shader expands it.
//!
//! For `GET_CURRENT_SOFTWARE_FRAMEBUFFER` the same buffer is handed to the
//! core to draw into, and then `video_refresh` has nothing to copy.
use libretro_sys::{RETRO_PIXEL_FORMAT_0RGB1555, RETRO_PIXEL_FORMAT_RGB565, RETRO_PIXEL_FORMAT_XRGB8888};
use std::ffi::{c_int, c_void};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    Rgb1555,
    Xrgb8888,
    Rgb565,
}

impl PixelFormat {
    pub fn from_retro(v: c_int) -> Option<Self> {
        match v {
            RETRO_PIXEL_FORMAT_0RGB1555 => Some(Self::Rgb1555),
            RETRO_PIXEL_FORMAT_XRGB8888 => Some(Self::Xrgb8888),
            RETRO_PIXEL_FORMAT_RGB565 => Some(Self::Rgb565),
            _ => None,
        }
    }
    pub fn to_retro(self) -> c_int {
        match self {
            Self::Rgb1555 => RETRO_PIXEL_FORMAT_0RGB1555,
            Self::Xrgb8888 => RETRO_PIXEL_FORMAT_XRGB8888,
            Self::Rgb565 => RETRO_PIXEL_FORMAT_RGB565,
        }
    }
    pub fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Xrgb8888 => 4,
            _ => 2,
        }
    }
}

/// The latest frame, packed (pitch = width * bytes per pixel).
pub struct Frame {
    pub format: PixelFormat,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    /// Frames presented so far (duplicates included).
    pub count: u64,
    /// The last call was a duplicate (NULL data): nothing new to show.
    pub duplicate: bool,
    /// The last frame is in the GPU framebuffer (HW rendering).
    pub hardware: bool,
    /// Changes whenever the pixel data changes (used to skip unchanged frames).
    pub serial: u64,
}

impl Default for Frame {
    fn default() -> Self {
        // libretro's default format is 0RGB1555 until the core sets another.
        Self { format: PixelFormat::Rgb1555, width: 0, height: 0, data: Vec::new(), count: 0, duplicate: false, hardware: false, serial: 0 }
    }
}

impl Frame {
    /// The core presented a frame (`retro_video_refresh_t`).
    ///
    /// # Safety
    /// `data` is NULL, `RETRO_HW_FRAME_BUFFER_VALID`, or points to `height` rows
    /// of `pitch` bytes, each holding `width` pixels of `self.format`.
    pub unsafe fn receive(&mut self, data: *const c_void, width: u32, height: u32, pitch: usize) {
        self.count += 1;
        if data.is_null() {
            self.duplicate = true;
            return;
        }
        self.duplicate = false;
        if data == libretro_sys::RETRO_HW_FRAME_BUFFER_VALID {
            self.hardware = true;
            self.width = width;
            self.height = height;
            self.serial += 1;
            return;
        }
        self.hardware = false;
        let bpp = self.format.bytes_per_pixel();
        let row = width as usize * bpp;
        let need = row * height as usize;
        self.width = width;
        self.height = height;
        self.serial += 1;
        // Drawn straight into our buffer (software framebuffer): nothing to copy.
        if data as *const u8 == self.data.as_ptr() && pitch == row && self.data.len() >= need {
            self.data.truncate(need);
            return;
        }
        if self.data.len() != need {
            self.data.resize(need, 0);
        }
        let src = data as *const u8;
        if pitch == row {
            std::ptr::copy_nonoverlapping(src, self.data.as_mut_ptr(), need);
        } else {
            for y in 0..height as usize {
                std::ptr::copy_nonoverlapping(src.add(y * pitch), self.data.as_mut_ptr().add(y * row), row);
            }
        }
    }

    /// A buffer the core may draw into directly (GET_CURRENT_SOFTWARE_FRAMEBUFFER).
    pub fn software_target(&mut self, width: u32, height: u32) -> (*mut c_void, usize) {
        let row = width as usize * self.format.bytes_per_pixel();
        let need = row * height as usize;
        if self.data.len() < need {
            self.data.resize(need, 0);
        }
        (self.data.as_mut_ptr() as *mut c_void, row)
    }

    /// The frame as RGBA8 (alpha 255).
    pub fn to_rgba(&self) -> Vec<u8> {
        let pixels = self.width as usize * self.height as usize;
        let mut out = vec![0u8; pixels * 4];
        if self.hardware || self.data.len() < pixels * self.format.bytes_per_pixel() {
            return out;
        }
        convert_to_rgba(self.format, &self.data[..pixels * self.format.bytes_per_pixel()], &mut out);
        out
    }

    /// FNV-1a over the pixels and size: equal frames give equal hashes.
    pub fn hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in self.width.to_le_bytes().iter().chain(self.height.to_le_bytes().iter()).chain(self.data.iter()) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }
}

/// Converts packed pixels of `format` to RGBA8. `out` holds 4 bytes per pixel.
pub fn convert_to_rgba(format: PixelFormat, src: &[u8], out: &mut [u8]) {
    match format {
        PixelFormat::Xrgb8888 => {
            for (px, o) in src.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
                // Little-endian 0x00RRGGBB is stored B, G, R, X.
                o[0] = px[2];
                o[1] = px[1];
                o[2] = px[0];
                o[3] = 255;
            }
        }
        PixelFormat::Rgb565 => {
            for (px, o) in src.chunks_exact(2).zip(out.chunks_exact_mut(4)) {
                let p = u16::from_le_bytes([px[0], px[1]]);
                let r = ((p >> 11) & 0x1f) as u8;
                let g = ((p >> 5) & 0x3f) as u8;
                let b = (p & 0x1f) as u8;
                o[0] = (r << 3) | (r >> 2);
                o[1] = (g << 2) | (g >> 4);
                o[2] = (b << 3) | (b >> 2);
                o[3] = 255;
            }
        }
        PixelFormat::Rgb1555 => {
            for (px, o) in src.chunks_exact(2).zip(out.chunks_exact_mut(4)) {
                let p = u16::from_le_bytes([px[0], px[1]]);
                let r = ((p >> 10) & 0x1f) as u8;
                let g = ((p >> 5) & 0x1f) as u8;
                let b = (p & 0x1f) as u8;
                o[0] = (r << 3) | (r >> 2);
                o[1] = (g << 3) | (g >> 2);
                o[2] = (b << 3) | (b >> 2);
                o[3] = 255;
            }
        }
    }
}

/// Writes RGBA8 pixels as a PNG.
pub fn write_png(path: &std::path::Path, width: u32, height: u32, rgba: &[u8]) -> std::io::Result<()> {
    let file = std::fs::File::create(path)?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut w = enc.write_header().map_err(std::io::Error::other)?;
    w.write_image_data(rgba).map_err(std::io::Error::other)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_each_format() {
        let mut out = [0u8; 4];
        convert_to_rgba(PixelFormat::Rgb565, &0xF800u16.to_le_bytes(), &mut out);
        assert_eq!(out, [255, 0, 0, 255]);
        convert_to_rgba(PixelFormat::Rgb565, &0x07E0u16.to_le_bytes(), &mut out);
        assert_eq!(out, [0, 255, 0, 255]);
        convert_to_rgba(PixelFormat::Rgb1555, &0x001Fu16.to_le_bytes(), &mut out);
        assert_eq!(out, [0, 0, 255, 255]);
        convert_to_rgba(PixelFormat::Xrgb8888, &0x00123456u32.to_le_bytes(), &mut out);
        assert_eq!(out, [0x12, 0x34, 0x56, 255]);
    }

    #[test]
    fn packs_rows_with_padding() {
        let mut f = Frame { format: PixelFormat::Rgb565, ..Frame::default() };
        // 2x2 pixels, pitch 8 bytes (4 bytes of padding per row).
        let src: [u8; 16] = [1, 0, 2, 0, 9, 9, 9, 9, 3, 0, 4, 0, 9, 9, 9, 9];
        unsafe { f.receive(src.as_ptr() as *const c_void, 2, 2, 8) };
        assert_eq!(f.data, vec![1, 0, 2, 0, 3, 0, 4, 0]);
        unsafe { f.receive(std::ptr::null(), 2, 2, 8) };
        assert!(f.duplicate);
        assert_eq!(f.count, 2);
    }
}
