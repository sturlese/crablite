---
name: web-search
description: Look something up on the web and read a page. Use when you need current information, a fact you're unsure of, or the contents of a specific URL.
---

# web-search

This skill needs no external binary — it uses the built-in `web_fetch` tool.

- To read a known page: call `web_fetch` with its URL; it returns the page text (HTML stripped).
- To find something first: fetch a search results page, e.g.
  `web_fetch("https://duckduckgo.com/html/?q=<your+query>")`, pick the most relevant result URL from
  the text, then `web_fetch` that page.

Guidelines:
- Prefer primary sources. Quote or paraphrase accurately and tell the user where it came from.
- If a page is huge, fetch it and summarize the relevant part rather than dumping it.
- Don't claim something is current unless the page shows a date.
