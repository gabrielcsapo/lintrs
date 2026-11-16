//! Byte offsets converted to the positions ESLint-compatible output uses:
//! one-based lines and zero-based UTF-16 columns and offsets.

/// A one-based line and zero-based UTF-16 column.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

pub struct LineIndex<'a> {
    text: &'a str,
    /// Byte offset where each line starts.
    line_starts: Vec<usize>,
    /// UTF-16 offset where each line starts.
    line_starts_utf16: Vec<usize>,
}

impl<'a> LineIndex<'a> {
    /// Lines end at `\r\n`, `\n` or `\r`, as in ESLint and graphql-js.
    pub fn new(text: &'a str) -> Self {
        Self::with_js_line_terminators(text, false)
    }

    pub fn with_js_line_terminators(text: &'a str, unicode: bool) -> Self {
        let bytes = text.as_bytes();
        let mut line_starts = vec![0];
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\n' => line_starts.push(index + 1),
                b'\r' => {
                    if bytes.get(index + 1) == Some(&b'\n') {
                        index += 1;
                    }
                    line_starts.push(index + 1);
                }
                0xe2 if unicode
                    && bytes.get(index + 1) == Some(&0x80)
                    && matches!(bytes.get(index + 2), Some(0xa8 | 0xa9)) =>
                {
                    index += 2;
                    line_starts.push(index + 1);
                }
                _ => {}
            }
            index += 1;
        }
        let mut line_starts_utf16 = Vec::with_capacity(line_starts.len());
        let mut previous = 0;
        let mut total = 0;
        for &start in &line_starts {
            total += utf16_len(&text[previous..start]);
            line_starts_utf16.push(total);
            previous = start;
        }
        Self {
            text,
            line_starts,
            line_starts_utf16,
        }
    }

    pub fn text(&self) -> &'a str {
        self.text
    }

    fn line_of(&self, offset: usize) -> usize {
        self.line_starts.partition_point(|&start| start <= offset) - 1
    }

    pub fn position(&self, offset: usize) -> Position {
        let line = self.line_of(offset);
        let start = self.line_starts[line];
        Position {
            line: to_u32(line + 1),
            column: to_u32(utf16_len(&self.text[start..offset])),
        }
    }

    pub fn utf16_offset(&self, offset: usize) -> usize {
        let line = self.line_of(offset);
        let start = self.line_starts[line];
        self.line_starts_utf16[line] + utf16_len(&self.text[start..offset])
    }
}

pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

pub fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_use_utf16_columns_and_all_line_endings() {
        let index = LineIndex::new("a\r\nb\rc\n😀d");
        assert_eq!(index.position(3), Position { line: 2, column: 0 });
        assert_eq!(index.position(5), Position { line: 3, column: 0 });
        assert_eq!(index.position(11), Position { line: 4, column: 2 });
        assert_eq!(index.utf16_offset(11), 9);
    }
}
