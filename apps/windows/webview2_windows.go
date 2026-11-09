package main

// WebView2's interface ids, the vtable index of each method the exe calls,
// and the enum and struct values it uses: only those.
//
// Transcribed from the WebView2 SDK 1.0.4314.35 (NuGet package
// Microsoft.Web.WebView2 1.0.4314.35): the C method tables
// (`typedef struct <Interface>Vtbl`) and MIDL_INTERFACE ids in
// build/native/include/WebView2.h, checked against WebView2.idl in the same
// package. In each table 0-2 are IUnknown's QueryInterface, AddRef and
// Release. An interface that extends another keeps every index of the one
// it extends (ICoreWebView2_4 : ICoreWebView2_3 : ICoreWebView2_2 :
// ICoreWebView2), and a published interface never changes, so these hold
// for every runtime that has the interface.

// Interface ids the exe asks for with QueryInterface.
var (
	iidEnvironment = mustGUID("b96d755e-0319-4e92-a296-23436f46a1fc") // ICoreWebView2Environment
	iidController2 = mustGUID("c979903e-d4ca-4228-92eb-47ee3fa96eab") // ICoreWebView2Controller2
	iidWebView4    = mustGUID("20d02d59-6df2-42dc-bd06-f98a694b1302") // ICoreWebView2_4
	iidSettings3   = mustGUID("fdb5ab74-af33-4854-84f0-0a631deb5eba") // ICoreWebView2Settings3
	iidSettings5   = mustGUID("183e7052-1d03-43a0-ab99-98e043b66b39") // ICoreWebView2Settings5
)

// Interface ids of the handlers the exe implements; each is IUnknown and
// then 3 Invoke(this, a, b).
const (
	// Invoke(HRESULT errorCode, ICoreWebView2Environment* result)
	iidEnvironmentCompleted = "4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d" // ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
	// Invoke(HRESULT errorCode, ICoreWebView2Controller* result)
	iidControllerCompleted = "6c4819f3-c9b7-4260-8127-c9f5bde7f68c" // ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
	// Invoke(HRESULT errorCode, LPCWSTR result): the script's id
	iidAddScriptCompleted = "b99369f3-9b11-47b5-bc6f-8e7895fcea17" // ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler
	// Invoke(HRESULT errorCode, LPCWSTR result): the result as JSON
	iidExecuteScriptCompleted = "49511172-cc67-4bca-9923-137112f4c4cc" // ICoreWebView2ExecuteScriptCompletedHandler
	// Invoke(ICoreWebView2Controller* sender, ICoreWebView2AcceleratorKeyPressedEventArgs* args)
	iidAcceleratorKeyPressed = "b29c7e28-fa79-41a8-8e44-65811c76dcb2" // ICoreWebView2AcceleratorKeyPressedEventHandler
	// Invoke(ICoreWebView2* sender, ICoreWebView2WebMessageReceivedEventArgs* args)
	iidWebMessageReceived = "57213f19-00e6-49fa-8e07-898ea01ecbd2" // ICoreWebView2WebMessageReceivedEventHandler
	// Invoke(ICoreWebView2* sender, ICoreWebView2NewWindowRequestedEventArgs* args)
	iidNewWindowRequested = "d4c185fe-c81c-4989-97af-2d3fa7ab5651" // ICoreWebView2NewWindowRequestedEventHandler
	// Invoke(ICoreWebView2* sender, IUnknown* args)
	iidDocumentTitleChanged = "f5f2b923-953e-4042-9f95-f3a118e1afd4" // ICoreWebView2DocumentTitleChangedEventHandler
	// Invoke(ICoreWebView2* sender, ICoreWebView2ProcessFailedEventArgs* args)
	iidProcessFailed = "79e0aea4-990b-42d9-aa1d-0fcc2e5bc7f1" // ICoreWebView2ProcessFailedEventHandler
	// Invoke(ICoreWebView2* sender, ICoreWebView2DownloadStartingEventArgs* args)
	iidDownloadStarting = "efedc989-c396-41ca-83f7-07f845a55724" // ICoreWebView2DownloadStartingEventHandler
)

// ICoreWebView2Environment (b96d755e-...).
const (
	// 3 CreateCoreWebView2Controller(HWND parentWindow, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler* handler)
	envCreateCoreWebView2Controller = 3
)

// ICoreWebView2Controller (4d00c0d1-9434-4eb6-8078-8697a560334f).
const (
	ctrlPutIsVisible = 4 // put_IsVisible(BOOL isVisible)
	// 6 put_Bounds(RECT bounds): a 16-byte struct, which the x64 calling
	// convention passes as a pointer to a copy.
	ctrlPutBounds                         = 6
	ctrlMoveFocus                         = 12 // MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON reason)
	ctrlAddAcceleratorKeyPressed          = 19 // add_AcceleratorKeyPressed(handler, EventRegistrationToken* token)
	ctrlNotifyParentWindowPositionChanged = 23 // NotifyParentWindowPositionChanged()
	ctrlClose                             = 24 // Close()
	ctrlGetCoreWebView2                   = 25 // get_CoreWebView2(ICoreWebView2** coreWebView2)
)

// ICoreWebView2Controller2 : ICoreWebView2Controller.
const (
	// 27 put_DefaultBackgroundColor(COREWEBVIEW2_COLOR value): a 4-byte
	// struct {BYTE A, R, G, B}, passed as an integer, A in the low byte.
	ctrl2PutDefaultBackgroundColor = 27
)

// ICoreWebView2 (76eceacb-0462-4d94-ac83-423a6793775e).
const (
	wvGetSettings                            = 3  // get_Settings(ICoreWebView2Settings** settings)
	wvNavigate                               = 5  // Navigate(LPCWSTR uri)
	wvAddProcessFailed                       = 25 // add_ProcessFailed(handler, EventRegistrationToken* token)
	wvAddScriptToExecuteOnDocumentCreated    = 27 // AddScriptToExecuteOnDocumentCreated(LPCWSTR javaScript, handler)
	wvRemoveScriptToExecuteOnDocumentCreated = 28 // RemoveScriptToExecuteOnDocumentCreated(LPCWSTR id)
	wvExecuteScript                          = 29 // ExecuteScript(LPCWSTR javaScript, handler)
	wvReload                                 = 31 // Reload()
	wvAddWebMessageReceived                  = 34 // add_WebMessageReceived(handler, EventRegistrationToken* token)
	wvAddNewWindowRequested                  = 44 // add_NewWindowRequested(handler, EventRegistrationToken* token)
	wvAddDocumentTitleChanged                = 46 // add_DocumentTitleChanged(handler, EventRegistrationToken* token)
	wvGetDocumentTitle                       = 48 // get_DocumentTitle(LPWSTR* title)
)

// ICoreWebView2_4 : ICoreWebView2_3 : ICoreWebView2_2 : ICoreWebView2.
const (
	wv4AddDownloadStarting = 75 // add_DownloadStarting(handler, EventRegistrationToken* token)
)

// ICoreWebView2Settings (e562e4f0-d7fa-43ac-8d71-c05150499f00).
const (
	setPutIsStatusBarEnabled            = 10 // put_IsStatusBarEnabled(BOOL)
	setPutAreDevToolsEnabled            = 12 // put_AreDevToolsEnabled(BOOL)
	setPutAreDefaultContextMenusEnabled = 14 // put_AreDefaultContextMenusEnabled(BOOL)
	setPutIsZoomControlEnabled          = 18 // put_IsZoomControlEnabled(BOOL)
)

// ICoreWebView2Settings3 : ICoreWebView2Settings2 : ICoreWebView2Settings.
const (
	set3PutAreBrowserAcceleratorKeysEnabled = 24 // put_AreBrowserAcceleratorKeysEnabled(BOOL)
)

// ICoreWebView2Settings5 : ICoreWebView2Settings4 : ICoreWebView2Settings3.
const (
	set5PutIsPinchZoomEnabled = 30 // put_IsPinchZoomEnabled(BOOL)
)

// ICoreWebView2AcceleratorKeyPressedEventArgs (9f760f8a-fb79-42be-9990-7b56900fa9c7).
const (
	keyGetKeyEventKind   = 3 // get_KeyEventKind(COREWEBVIEW2_KEY_EVENT_KIND*)
	keyGetVirtualKey     = 4 // get_VirtualKey(UINT*)
	keyGetKeyEventLParam = 5 // get_KeyEventLParam(INT*)
	keyPutHandled        = 8 // put_Handled(BOOL)
)

// ICoreWebView2WebMessageReceivedEventArgs (0f99a40c-e962-4207-9e92-e3d542eff849).
const (
	msgGetSource           = 3 // get_Source(LPWSTR*)
	msgGetWebMessageAsJSON = 4 // get_WebMessageAsJson(LPWSTR*)
)

// ICoreWebView2NewWindowRequestedEventArgs (34acb11c-fc37-4418-9132-f9c21d1eafb9).
const (
	newWindowGetURI     = 3 // get_Uri(LPWSTR*)
	newWindowPutHandled = 6 // put_Handled(BOOL)
)

// ICoreWebView2DownloadStartingEventArgs (e99bbe21-43e9-4544-a732-282764eafa60).
const (
	downloadGetResultFilePath = 6 // get_ResultFilePath(LPWSTR*)
	downloadPutResultFilePath = 7 // put_ResultFilePath(LPCWSTR)
	downloadPutHandled        = 9 // put_Handled(BOOL)
)

// ICoreWebView2ProcessFailedEventArgs (8155a9a4-1474-4a86-8cae-151b0fa6b8ca).
const (
	failedGetProcessFailedKind = 3 // get_ProcessFailedKind(COREWEBVIEW2_PROCESS_FAILED_KIND*)
)

// Enum and struct values.
const (
	// COREWEBVIEW2_PROCESS_FAILED_KIND
	browserProcessExited      = 0
	renderProcessExited       = 1
	renderProcessUnresponsive = 2
	// COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC
	moveFocusProgrammatic = 0
	// COREWEBVIEW2_COLOR{A: 255, R: 0, G: 0, B: 0} as its 4 bytes read
	// as a little-endian integer.
	opaqueBlack = 0x000000FF
)
