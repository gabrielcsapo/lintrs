//! JSON with comments and trailing commas, as `.oxlintrc.json` allows.

/// Replaces comments with spaces and drops trailing commas, keeping byte
/// offsets so serde's error positions still point into the original text.
pub fn strip(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = bytes.to_vec();
    let mut index = 0;
    let mut in_string = false;
    let mut pending_comma: Option<usize> = None;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            match byte {
                b'\\' => index += 1,
                b'"' => in_string = false,
                _ => {}
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = true;
                pending_comma = None;
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    out[index] = b' ';
                    index += 1;
                }
                continue;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                let end = text[index + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |found| index + 2 + found + 2);
                for slot in &mut out[index..end] {
                    if *slot != b'\n' {
                        *slot = b' ';
                    }
                }
                index = end;
                continue;
            }
            b',' => pending_comma = Some(index),
            b'}' | b']' => {
                if let Some(comma) = pending_comma.take() {
                    out[comma] = b' ';
                }
            }
            byte if byte.is_ascii_whitespace() => {}
            _ => pending_comma = None,
        }
        index += 1;
    }
    // Only ASCII bytes outside strings were replaced, so this stays valid UTF-8.
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::strip;

    #[test]
    fn strips_comments_and_trailing_commas_outside_strings() {
        let text = "{\n  // a\n  \"x\": \"// not /* a comment\", /* b */\n  \"y\": [1, 2,],\n}";
        let value: serde_json::Value = serde_json::from_str(&strip(text)).unwrap();
        assert_eq!(value["x"], "// not /* a comment");
        assert_eq!(value["y"], serde_json::json!([1, 2]));
    }
}
