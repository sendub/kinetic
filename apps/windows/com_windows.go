package main

// COM plumbing for WebView2, with syscall alone: calling methods on the
// interfaces WebView2 hands over, and the handler objects the exe hands
// it. Every WebView2 completion and event handler is IUnknown plus one
// Invoke(this, a, b), so one Go type serves them all, and its four methods
// are four callbacks made once for the whole run (Windows allows only a
// limited number of syscall.NewCallback callbacks).

import (
	"sync/atomic"
	"syscall"
	"unsafe"
)

// HRESULTs the handlers return (WinError.h).
const (
	sOK          = 0
	eNoInterface = 0x80004002
	ePointer     = 0x80004003
)

// IUnknown's methods, at the start of every COM interface.
const (
	iunknownQueryInterface = 0
	iunknownAddRef         = 1
	iunknownRelease        = 2
)

// comMethods bounds the method tables comObject can index; the highest
// index the exe calls is 75 (webview2_windows.go).
const comMethods = 128

// comObject is a COM interface pointer WebView2 handed over: the object's
// first word points at its method table.
type comObject struct{ vtbl *[comMethods]uintptr }

// comAt is a COM interface pointer handed over as a number.
func comAt(p uintptr) *comObject {
	return ptrAt[comObject](p)
}

// call runs method (its index in the interface's table) with this and
// args, and returns its HRESULT. Pointers in args stay put and alive for
// the call (go:uintptrescapes), as for syscall's own Proc.Call.
//
//go:uintptrescapes
func (o *comObject) call(method int, args ...uintptr) int32 {
	r, _, _ := syscall.SyscallN(o.vtbl[method], append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)...)

	return int32(r)
}

// query is the object's interface iid (one reference the caller owns),
// or nil when it has none, as on an older runtime.
func (o *comObject) query(iid *guid) *comObject {
	var out *comObject
	if hr := o.call(iunknownQueryInterface, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out))); hr < 0 {
		return nil
	}

	return out
}

func (o *comObject) addRef() {
	o.call(iunknownAddRef)
}

func (o *comObject) release() {
	if o != nil {
		o.call(iunknownRelease)
	}
}

// getObject runs a getter whose result is an interface (one reference
// the caller owns).
func (o *comObject) getObject(method int) (*comObject, int32) {
	var out *comObject
	hr := o.call(method, uintptr(unsafe.Pointer(&out)))

	return out, hr
}

// getString runs a getter whose result is a string the caller frees.
func (o *comObject) getString(method int) (string, int32) {
	var p *uint16

	hr := o.call(method, uintptr(unsafe.Pointer(&p)))
	defer coTaskMemFree(p)

	return utf16At(p), hr
}

// putBool runs a BOOL setter.
func (o *comObject) putBool(method int, value bool) int32 {
	if value {
		return o.call(method, 1)
	}

	return o.call(method, 0)
}

// putString runs a string setter.
func (o *comObject) putString(method int, value string) int32 {
	return o.call(method, uintptr(unsafe.Pointer(utf16(value))))
}

// comHandler is a handler object the exe implements. Its first word points
// at handlerMethods, so COM sees an interface; the rest is the exe's.
type comHandler struct {
	vtbl   *[4]uintptr
	iid    guid
	name   string
	refs   int32
	invoke func(a, b uintptr)
}

var (
	iidIUnknown = mustGUID("00000000-0000-0000-C000-000000000046")

	// handlerMethods is every handler's method table: QueryInterface,
	// AddRef, Release, Invoke.
	handlerMethods = [4]uintptr{
		syscall.NewCallback(handlerQueryInterface),
		syscall.NewCallback(handlerAddRef),
		syscall.NewCallback(handlerRelease),
		syscall.NewCallback(handlerInvoke),
	}

	// handlers keeps every handler reachable for the whole run: WebView2
	// holds pointers to them that Go cannot see.
	handlers []*comHandler
)

// newHandler makes a handler for interface iid whose Invoke runs invoke
// with its two arguments (an HRESULT and a result for a completion
// handler, the sender and the event's arguments for an event handler).
func newHandler(name, iid string, invoke func(a, b uintptr)) *comHandler {
	h := &comHandler{vtbl: &handlerMethods, iid: mustGUID(iid), name: name, refs: 1, invoke: invoke}
	handlers = append(handlers, h)

	return h
}

func handlerQueryInterface(this *comHandler, iid *guid, out *uintptr) uintptr {
	if out == nil || iid == nil {
		return ePointer
	}

	if *iid != iidIUnknown && *iid != this.iid {
		*out = 0

		return eNoInterface
	}

	atomic.AddInt32(&this.refs, 1)
	*out = uintptr(unsafe.Pointer(this))

	return sOK
}

func handlerAddRef(this *comHandler) uintptr {
	return uintptr(atomic.AddInt32(&this.refs, 1))
}

// handlerRelease counts down but never frees: handlers live for the run.
func handlerRelease(this *comHandler) uintptr {
	if n := atomic.AddInt32(&this.refs, -1); n > 0 {
		return uintptr(n)
	}

	atomic.StoreInt32(&this.refs, 1)

	return 1
}

// handlerInvoke runs the handler. A panic in it is logged and the game
// carries on, rather than ending the process from inside WebView2.
func handlerInvoke(this *comHandler, a, b uintptr) uintptr {
	defer func() {
		if r := recover(); r != nil {
			logf("%s: %v", this.name, r)
		}
	}()

	this.invoke(a, b)

	return sOK
}
