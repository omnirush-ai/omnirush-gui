#!/usr/bin/env python3
# Writes the Safari fixtures beside this file: Bookmarks.plist (binary plist) and Cookies.binarycookies.
# Synthetic data only. Run again after changing the tables below: python3 make-safari-fixtures.py
import datetime
import os
import plistlib
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
APPLE_EPOCH = 978307200

bookmarks = {
    "WebBookmarkType": "WebBookmarkTypeList",
    "Title": "",
    "Children": [
        {"WebBookmarkType": "WebBookmarkTypeProxy", "Title": "History"},
        {
            "WebBookmarkType": "WebBookmarkTypeList",
            "Title": "BookmarksBar",
            "Children": [
                {"WebBookmarkType": "WebBookmarkTypeLeaf", "URLString": "https://news.example.com/", "URIDictionary": {"title": "Example News"}},
                {
                    "WebBookmarkType": "WebBookmarkTypeList",
                    "Title": "Work",
                    "Children": [
                        {"WebBookmarkType": "WebBookmarkTypeLeaf", "URLString": "https://tracker.example.org/board", "URIDictionary": {"title": "Board ✓"}},
                        {"WebBookmarkType": "WebBookmarkTypeLeaf", "URLString": "javascript:alert(1)", "URIDictionary": {"title": "Bookmarklet"}},
                    ],
                },
            ],
        },
        {"WebBookmarkType": "WebBookmarkTypeList", "Title": "BookmarksMenu", "Children": []},
        {
            "WebBookmarkType": "WebBookmarkTypeList",
            "Title": "com.apple.ReadingList",
            "Children": [
                {
                    "WebBookmarkType": "WebBookmarkTypeLeaf",
                    "URLString": "https://blog.example.net/post",
                    "URIDictionary": {"title": "A long read"},
                    "ReadingList": {"DateAdded": datetime.datetime(2026, 11, 1, 12, 0, 0)},
                },
            ],
        },
        {"WebBookmarkType": "WebBookmarkTypeLeaf", "URLString": "https://loose.example.com/", "URIDictionary": {"title": "Loose link"}},
    ],
}

with open(os.path.join(HERE, "Bookmarks.plist"), "wb") as handle:
    plistlib.dump(bookmarks, handle, fmt=plistlib.FMT_BINARY)


def cookie(flags, host, name, path, value, expiry_unix, created_unix):
    strings = b""
    offsets = []
    for text in (host, name, path, value):
        offsets.append(56 + len(strings))
        strings += text.encode("utf-8") + b"\0"
    size = 56 + len(strings)
    head = struct.pack("<IIII", size, 1, flags, 0)
    head += struct.pack("<IIII", *offsets)
    head += b"\0" * 8
    head += struct.pack("<dd", expiry_unix - APPLE_EPOCH, created_unix - APPLE_EPOCH)
    return head + strings


def page(cookies):
    header_size = 4 + 4 + 4 * len(cookies) + 4
    offsets = []
    body = b""
    for entry in cookies:
        offsets.append(header_size + len(body))
        body += entry
    data = struct.pack(">I", 0x100) + struct.pack("<I", len(cookies))
    data += b"".join(struct.pack("<I", offset) for offset in offsets)
    data += struct.pack(">I", 0)
    return data + body


FAR = 2_000_000_000  # 2033
NOW = 1_795_000_000  # 2026-11
pages = [
    page([
        cookie(5, ".example.com", "sid", "/", "safari-session-fixture", FAR, NOW - 60),
        cookie(1, "www.example.com", "theme", "/", "dark", FAR, NOW - 120),
    ]),
    page([
        cookie(4, "bank.example", "auth", "/", "bank-fixture", FAR, NOW - 30),
    ]),
]
data = b"cook" + struct.pack(">I", len(pages)) + b"".join(struct.pack(">I", len(p)) for p in pages) + b"".join(pages)
data += b"\0" * 8 + bytes.fromhex("071720050000004b")
with open(os.path.join(HERE, "Cookies.binarycookies"), "wb") as handle:
    handle.write(data)
