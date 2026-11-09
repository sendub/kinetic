package main

import (
	"syscall"
	"unsafe"
)

// readRuntimeRegistry reads what the registry says about the WebView2
// Runtime (runtime.go): per machine in the 32-bit view (WOW6432Node, where
// the runtime registers on 64-bit Windows) and the native one, then per
// user.
func readRuntimeRegistry() []runtimeReading {
	views := []struct {
		root    syscall.Handle
		access  uint32
		name    string
		perUser bool
	}{
		{syscall.HKEY_LOCAL_MACHINE, syscall.KEY_WOW64_32KEY, "HKLM (32-bit view)", false},
		{syscall.HKEY_LOCAL_MACHINE, syscall.KEY_WOW64_64KEY, "HKLM (64-bit view)", false},
		{syscall.HKEY_CURRENT_USER, syscall.KEY_WOW64_32KEY, "HKCU", true},
	}

	readings := make([]runtimeReading, 0, len(views))
	for _, v := range views {
		readings = append(readings, runtimeReading{
			View:     v.name,
			PerUser:  v.perUser,
			Folder:   registryString(v.root, runtimeStateKey, "EBWebView", v.access),
			Version:  registryString(v.root, runtimeClientsKey, "pv", v.access),
			Location: registryString(v.root, runtimeClientsKey, "location", v.access),
		})
	}

	return readings
}

// registryString is a string value, or "" when the key or value is
// missing or not a string.
func registryString(root syscall.Handle, path, name string, access uint32) string {
	var key syscall.Handle
	if syscall.RegOpenKeyEx(root, utf16(path), 0, syscall.KEY_QUERY_VALUE|access, &key) != nil {
		return ""
	}

	defer func() { _ = syscall.RegCloseKey(key) }()

	var kind, n uint32
	if syscall.RegQueryValueEx(key, utf16(name), nil, &kind, nil, &n) != nil ||
		(kind != syscall.REG_SZ && kind != syscall.REG_EXPAND_SZ) || n == 0 {
		return ""
	}

	buf := make([]uint16, n/2+1)
	n = uint32(2 * len(buf))

	if syscall.RegQueryValueEx(key, utf16(name), nil, &kind, (*byte)(unsafe.Pointer(&buf[0])), &n) != nil {
		return ""
	}

	return syscall.UTF16ToString(buf)
}
