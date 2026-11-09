package main

import "testing"

func TestParseGUIDMatchesTheLoadersByteForm(t *testing.T) {
	// The two ids jchv/OpenWebView2Loader writes out as GUID structs
	// (Source/WebView2Loader.cpp), against WebView2.idl's text form.
	cases := map[string]guid{
		"4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d": {0x4e8a3389, 0xc9d8, 0x4bd2,
			[8]byte{0xb6, 0xb5, 0x12, 0x4f, 0xee, 0x6c, 0xc1, 0x4d}},
		"{b96d755e-0319-4e92-a296-23436f46a1fc}": {0xb96d755e, 0x0319, 0x4e92,
			[8]byte{0xa2, 0x96, 0x23, 0x43, 0x6f, 0x46, 0xa1, 0xfc}},
		"00000000-0000-0000-C000-000000000046": {0, 0, 0, [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}},
	}
	for text, want := range cases {
		if got, ok := parseGUID(text); !ok || got != want {
			t.Errorf("parseGUID(%q) = %#v, %v; want %#v", text, got, ok, want)
		}
	}

	for _, text := range []string{"", "4e8a3389c9d84bd2b6b5124fee6cc14d", "4e8a3389-c9d8-4bd2-b6b5-124fee6cc14", "zz8a3389-c9d8-4bd2-b6b5-124fee6cc14d"} {
		if _, ok := parseGUID(text); ok {
			t.Errorf("parseGUID(%q) accepted", text)
		}
	}
}

func TestMustGUIDPanicsOnABadID(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("mustGUID accepted a bad id")
		}
	}()

	mustGUID("nope")
}
