package main

import (
	"encoding/hex"
	"strings"
)

// guid is a COM GUID (an interface id) in its Windows memory layout.
type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// parseGUID reads "4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d", with or without
// braces, as WebView2.idl writes interface ids.
func parseGUID(text string) (guid, bool) {
	text = strings.TrimSuffix(strings.TrimPrefix(text, "{"), "}")

	parts := strings.Split(text, "-")
	if len(parts) != 5 || len(parts[0]) != 8 || len(parts[1]) != 4 || len(parts[2]) != 4 ||
		len(parts[3]) != 4 || len(parts[4]) != 12 {
		return guid{}, false
	}

	raw, err := hex.DecodeString(strings.Join(parts, ""))
	if err != nil {
		return guid{}, false
	}

	g := guid{
		Data1: uint32(raw[0])<<24 | uint32(raw[1])<<16 | uint32(raw[2])<<8 | uint32(raw[3]),
		Data2: uint16(raw[4])<<8 | uint16(raw[5]),
		Data3: uint16(raw[6])<<8 | uint16(raw[7]),
	}
	copy(g.Data4[:], raw[8:])

	return g, true
}

// mustGUID is parseGUID for the ids written in this package.
func mustGUID(text string) guid {
	g, ok := parseGUID(text)
	if !ok {
		panic("bad GUID " + text)
	}

	return g
}
