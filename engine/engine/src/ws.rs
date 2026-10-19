//! A small WebSocket server (RFC 6455) for the one page a session talks to.
//!
//! Only what the engine needs: the HTTP upgrade handshake, masked client
//! frames (text, binary, ping, close, fragments), unmasked server frames. A
//! connection's `TcpStream` is cloned so one thread reads while another
//! writes, which keeps frames flowing out while input flows in.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE: usize = 1 << 20;

/// The request a page sent to open the socket.
pub struct Request {
    pub path: String,
    pub origin: Option<String>,
}

pub enum Message {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

pub enum Opcode {
    Text = 1,
    Binary = 2,
    Close = 8,
    Ping = 9,
    Pong = 10,
}

/// Reads the HTTP upgrade request. Call `accept` or `reject` next.
pub fn read_request(stream: &mut TcpStream) -> Result<(Request, String), String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if buf.len() > 16 * 1024 {
            return Err("request too large".into());
        }
        match stream.read(&mut byte) {
            Ok(0) => return Err("closed during the handshake".into()),
            Ok(_) => buf.push(byte[0]),
            Err(e) => return Err(e.to_string()),
        }
    }
    stream.set_read_timeout(None).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split(' ');
    if parts.next() != Some("GET") {
        return Err("not a GET".into());
    }
    let path = parts.next().unwrap_or("/").to_string();
    let (mut key, mut origin, mut upgrade) = (None, None, false);
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            match k.trim().to_ascii_lowercase().as_str() {
                "sec-websocket-key" => key = Some(v.to_string()),
                "origin" => origin = Some(v.to_string()),
                "upgrade" => upgrade = v.eq_ignore_ascii_case("websocket"),
                _ => {}
            }
        }
    }
    let key = key.filter(|_| upgrade).ok_or("not a WebSocket request")?;
    Ok((Request { path, origin }, key))
}

pub fn accept(stream: &mut TcpStream, key: &str) -> std::io::Result<()> {
    let accept = base64(&sha1(format!("{key}{GUID}").as_bytes()));
    let resp = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
    stream.write_all(resp.as_bytes())?;
    stream.set_nodelay(true)
}

pub fn reject(stream: &mut TcpStream, status: &str) {
    let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
}

/// Writes one unmasked frame whose payload is `parts` joined.
pub fn write_frame(stream: &mut TcpStream, op: Opcode, parts: &[&[u8]]) -> std::io::Result<()> {
    let len: usize = parts.iter().map(|p| p.len()).sum();
    let mut head = [0u8; 10];
    head[0] = 0x80 | op as u8;
    let n = if len < 126 {
        head[1] = len as u8;
        2
    } else if len <= 0xFFFF {
        head[1] = 126;
        head[2..4].copy_from_slice(&(len as u16).to_be_bytes());
        4
    } else {
        head[1] = 127;
        head[2..10].copy_from_slice(&(len as u64).to_be_bytes());
        10
    };
    // Small payloads go out in one write with the header.
    if len <= 256 {
        let mut one = Vec::with_capacity(n + len);
        one.extend_from_slice(&head[..n]);
        for p in parts {
            one.extend_from_slice(p);
        }
        return stream.write_all(&one);
    }
    stream.write_all(&head[..n])?;
    for p in parts {
        stream.write_all(p)?;
    }
    Ok(())
}

/// Reads the next message; answers pings through `pong` (the writing side).
pub fn read_message(stream: &mut TcpStream, mut pong: impl FnMut(&[u8])) -> std::io::Result<Message> {
    let mut message: Vec<u8> = Vec::new();
    let mut message_op = 0u8;
    loop {
        let mut h = [0u8; 2];
        stream.read_exact(&mut h)?;
        let fin = h[0] & 0x80 != 0;
        let op = h[0] & 0x0f;
        let masked = h[1] & 0x80 != 0;
        let mut len = (h[1] & 0x7f) as u64;
        if len == 126 {
            let mut b = [0u8; 2];
            stream.read_exact(&mut b)?;
            len = u16::from_be_bytes(b) as u64;
        } else if len == 127 {
            let mut b = [0u8; 8];
            stream.read_exact(&mut b)?;
            len = u64::from_be_bytes(b);
        }
        if len as usize > MAX_MESSAGE || message.len() + len as usize > MAX_MESSAGE {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "message too large"));
        }
        let mut mask = [0u8; 4];
        if masked {
            stream.read_exact(&mut mask)?;
        }
        let mut payload = vec![0u8; len as usize];
        stream.read_exact(&mut payload)?;
        if masked {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i & 3];
            }
        }
        match op {
            8 => return Ok(Message::Close),
            9 => {
                pong(&payload);
                continue;
            }
            10 => continue,
            0 => message.extend_from_slice(&payload),
            1 | 2 => {
                message_op = op;
                message = payload;
            }
            _ => return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unknown opcode")),
        }
        if fin {
            return Ok(if message_op == 1 { Message::Text(String::from_utf8_lossy(&message).into_owned()) } else { Message::Binary(message) });
        }
    }
}

// ── SHA-1 and base64 for the handshake ──────────────────────────────────
pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_accept_matches_the_rfc_example() {
        // RFC 6455 section 1.3.
        assert_eq!(base64(&sha1(format!("dGhlIHNhbXBsZSBub25jZQ=={GUID}").as_bytes())), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
    }
}
