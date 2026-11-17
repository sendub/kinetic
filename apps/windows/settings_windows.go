package main

// Reading the settings resource (settings.go) from the exe's own image.

import "unsafe"

var (
	procFindResource   = kernel32.NewProc("FindResourceW")
	procLoadResource   = kernel32.NewProc("LoadResource")
	procLockResource   = kernel32.NewProc("LockResource")
	procSizeofResource = kernel32.NewProc("SizeofResource")
)

// rtRCData is RT_RCDATA, raw data (WinUser.h).
const rtRCData = 10

// settingsResource is a copy of the settings resource's bytes; nil when
// the exe has none. A null module is the exe's own, and its resources
// are mapped with it, so nothing is read from disk.
func settingsResource() []byte {
	found, _, _ := procFindResource.Call(0, settingsResourceID, rtRCData)
	if found == 0 {
		return nil
	}

	size, _, _ := procSizeofResource.Call(0, found)
	loaded, _, _ := procLoadResource.Call(0, found)

	if size == 0 || loaded == 0 {
		return nil
	}

	data, _, _ := procLockResource.Call(loaded)
	if data == 0 {
		return nil
	}

	return append([]byte(nil), unsafe.Slice(ptrAt[byte](data), size)...)
}

// loadSettings reads the game's settings from the exe.
func loadSettings() hostSettings {
	return parseSettings(settingsResource())
}
