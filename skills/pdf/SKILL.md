---
name: pdf
description: Read, summarize or answer questions about a PDF file (e.g. a document saved to inbox/ from the chat). Use whenever the user sends a PDF or asks about one.
metadata:
  crablite:
    requires:
      bins: ["pdftotext"]
---

# pdf

Extract the text with the `exec` tool, then answer from it:

- Whole document: `pdftotext 'inbox/<file>.pdf' -`
- Page range: `pdftotext -f 2 -l 5 'inbox/<file>.pdf' -`
- Layout-preserving (tables): `pdftotext -layout 'inbox/<file>.pdf' -`

The trailing `-` prints to stdout. Long output gets truncated — prefer page ranges for big
documents, or `pdftotext ... out.txt` + `read` with line ranges.

If nothing comes out, the PDF is probably a scanned image without a text layer — say so
instead of guessing. To share the file (or a processed copy) back to the chat, use `send_file`.
