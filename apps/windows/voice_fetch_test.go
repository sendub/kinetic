package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// tarEntry is one file of a test archive.
type tarEntry struct {
	name, body, link string
	mode             int64
	kind             byte
}

// makeArchive is a .tar.gz of entries.
func makeArchive(t *testing.T, entries []tarEntry) []byte {
	t.Helper()

	var buf bytes.Buffer

	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	for _, e := range entries {
		kind := e.kind
		if kind == 0 {
			kind = tar.TypeReg
		}

		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}

		h := &tar.Header{Name: e.name, Typeflag: kind, Mode: mode, Size: int64(len(e.body)), Linkname: e.link}
		if kind != tar.TypeReg {
			h.Size = 0
		}

		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}

		if kind == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}

	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}

	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	return buf.Bytes()
}

func sha256Text(data []byte) string {
	sum := sha256.Sum256(data)

	return hex.EncodeToString(sum[:])
}

// pythonArchive is an install_only-shaped archive: python/python.exe and a
// library file.
func pythonArchive(t *testing.T, exe string) []byte {
	return makeArchive(t, []tarEntry{
		{name: "python/", kind: tar.TypeDir, mode: 0o755},
		{name: "python/python.exe", body: exe, mode: 0o755},
		{name: "python/Lib/os.py", body: "# os\n"},
		{name: "python/Lib/encodings/", kind: tar.TypeDir, mode: 0o755},
		{name: "python/Lib/encodings/utf_8.py", body: "# utf-8\n"},
	})
}

func TestUnpackPythonInstallsTheArchive(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "downloads", "python.tar.gz.partial")
	data := pythonArchive(t, "#!/bin/sh\n")

	if err := os.MkdirAll(filepath.Dir(archive), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(archive, data, 0o644); err != nil {
		t.Fatal(err)
	}

	// An old Python is replaced.
	if err := os.MkdirAll(filepath.Join(root, "python", "old"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := unpackPython(archive, sha256Text(data), root); err != nil {
		t.Fatal(err)
	}

	for name, want := range map[string]string{
		"python/python.exe":             "#!/bin/sh\n",
		"python/Lib/encodings/utf_8.py": "# utf-8\n",
		"python/" + pythonMarker:        sha256Text(data),
	} {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil || string(got) != want {
			t.Errorf("%s = %q, %v; want %q", name, got, err, want)
		}
	}

	if info, err := os.Stat(filepath.Join(root, "python", "python.exe")); err != nil || info.Mode()&0o100 == 0 {
		t.Errorf("python.exe lost its mode: %v %v", info.Mode(), err)
	}

	for _, gone := range []string{"python/old", "python.partial", "downloads"} {
		if _, err := os.Stat(filepath.Join(root, gone)); !os.IsNotExist(err) {
			t.Errorf("%s is still there", gone)
		}
	}
}

func TestUnpackPythonKeepsADownloadsFolderWithMoreInIt(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "downloads", "python.tar.gz.partial")
	data := pythonArchive(t, "exe")
	writeFile(t, archive, data)
	writeFile(t, filepath.Join(root, "downloads", "wheel.whl"), []byte("w"))

	if err := unpackPython(archive, sha256Text(data), root); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(root, "downloads", "wheel.whl")); err != nil {
		t.Errorf("the helper's download went: %v", err)
	}
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestUnpackPythonRefusesBadArchives(t *testing.T) {
	cases := map[string]struct {
		data     []byte
		sha      string
		want     string
		deleted  bool
		noPython bool
	}{
		"checksum": {
			data: pythonArchive(t, "x"), sha: "00",
			want:    "The Python download did not match its checksum, so it was deleted. Try again.",
			deleted: true,
		},
		"no python.exe": {
			data: makeArchive(t, []tarEntry{{name: "python/bin/python3", body: "x"}}),
			want: `The Python download holds no python\python.exe.`,
		},
		"escapes": {
			data: makeArchive(t, []tarEntry{{name: "python/python.exe", body: "x"}, {name: "../evil.txt", body: "x"}}),
			want: "Python could not be unpacked: the archive's ../evil.txt is outside its folder",
		},
		"absolute": {
			data: makeArchive(t, []tarEntry{{name: "/evil.txt", body: "x"}}),
			want: "Python could not be unpacked: the archive's /evil.txt is outside its folder",
		},
		"link out": {
			data: makeArchive(t, []tarEntry{{name: "python/python.exe", body: "x"},
				{name: "python/x", kind: tar.TypeSymlink, link: "../../outside"}}),
			want: "Python could not be unpacked: the archive's python/x links outside its folder",
		},
		"not gzip": {
			data: []byte("this is not an archive"),
			want: "Python could not be unpacked: gzip: invalid header",
		},
	}

	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			archive := filepath.Join(root, "downloads", "p.partial")
			writeFile(t, archive, c.data)

			sha := c.sha
			if sha == "" {
				sha = sha256Text(c.data)
			}

			err := unpackPython(archive, sha, root)
			if err == nil || err.Error() != c.want {
				t.Fatalf("unpackPython = %v, want %q", err, c.want)
			}

			if _, statErr := os.Stat(archive); c.deleted != os.IsNotExist(statErr) {
				t.Errorf("archive deleted = %v, want %v", os.IsNotExist(statErr), c.deleted)
			}

			for _, gone := range []string{"python", "python.partial", "evil.txt", "../evil.txt"} {
				if _, err := os.Stat(filepath.Join(root, gone)); !os.IsNotExist(err) {
					t.Errorf("%s is there after a refused archive", gone)
				}
			}
		})
	}
}

// rangeServer serves body with Range support (http.ServeContent), counting
// requests and recording each Range header.
type rangeServer struct {
	body     []byte
	requests atomic.Int32
	ranges   []string
	noRange  bool
	status   int
	cut      int // when > 0, the first full response stops after cut bytes
}

func (s *rangeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	n := s.requests.Add(1)
	s.ranges = append(s.ranges, r.Header.Get("Range"))

	if r.Header.Get("User-Agent") != "kinetic-voice" {
		http.Error(w, "no user agent", http.StatusForbidden)

		return
	}

	if s.status != 0 {
		http.Error(w, "nope", s.status)

		return
	}

	if s.cut > 0 && n == 1 {
		w.Header().Set("Content-Length", "100000")
		_, _ = w.Write(s.body[:s.cut])

		return
	}

	if s.noRange {
		r.Header.Del("Range")
	}

	http.ServeContent(w, r, "p.tar.gz", time.Time{}, bytes.NewReader(s.body))
}

func TestDownloadFileFetchesResumesAndRestarts(t *testing.T) {
	body := bytes.Repeat([]byte("0123456789"), 10000)
	srv := &rangeServer{body: body}
	server := httptest.NewServer(srv)
	t.Cleanup(server.Close)

	dir := t.TempDir()
	partial := filepath.Join(dir, "p.partial")

	var seen []int64

	progress := func(have int64) { seen = append(seen, have) }

	// A partial file from an earlier run: only the rest is asked for.
	writeFile(t, partial, body[:30000])

	if err := downloadFile(context.Background(), http.DefaultClient, server.URL+"/p", partial, int64(len(body)),
		progress); err != nil {
		t.Fatal(err)
	}

	if got, _ := os.ReadFile(partial); !bytes.Equal(got, body) {
		t.Error("the resumed file differs")
	}

	if srv.ranges[0] != "bytes=30000-" || len(seen) == 0 || seen[len(seen)-1] != int64(len(body)) || seen[0] <= 30000 {
		t.Errorf("ranges %v, progress %v", srv.ranges, seen)
	}

	// Complete already: no request.
	if err := downloadFile(context.Background(), http.DefaultClient, server.URL+"/p", partial, int64(len(body)),
		progress); err != nil || srv.requests.Load() != 1 {
		t.Errorf("a complete file: %v, %d requests", err, srv.requests.Load())
	}

	// A server that answers a Range with the whole file: start again.
	srv.noRange = true

	writeFile(t, partial, []byte("garbage!"))

	if err := downloadFile(context.Background(), http.DefaultClient, server.URL+"/p", partial, int64(len(body)),
		progress); err != nil {
		t.Fatal(err)
	}

	if got, _ := os.ReadFile(partial); !bytes.Equal(got, body) {
		t.Error("the restarted file differs")
	}

	// A partial file longer than the whole: thrown away.
	srv.noRange = false

	writeFile(t, partial, append(append([]byte{}, body...), 'x'))

	if err := downloadFile(context.Background(), http.DefaultClient, server.URL+"/p", partial, int64(len(body)),
		progress); err != nil {
		t.Fatal(err)
	}

	if got, _ := os.ReadFile(partial); !bytes.Equal(got, body) || srv.ranges[len(srv.ranges)-1] != "" {
		t.Errorf("an over-long partial: equal %v, last range %q", bytes.Equal(got, body), srv.ranges[len(srv.ranges)-1])
	}
}

func TestDownloadFileFailures(t *testing.T) {
	body := bytes.Repeat([]byte("x"), 100000)

	t.Run("http error", func(t *testing.T) {
		server := httptest.NewServer(&rangeServer{body: body, status: http.StatusNotFound})
		t.Cleanup(server.Close)

		err := downloadFile(context.Background(), http.DefaultClient, server.URL, filepath.Join(t.TempDir(), "p"),
			int64(len(body)), func(int64) {})
		if err == nil || err.Error() != "The Python download failed (HTTP 404)." {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("short", func(t *testing.T) {
		server := httptest.NewServer(&rangeServer{body: body, cut: 5000})
		t.Cleanup(server.Close)

		partial := filepath.Join(t.TempDir(), "p")

		err := downloadFile(context.Background(), http.DefaultClient, server.URL, partial, int64(len(body)),
			func(int64) {})
		if err == nil || !strings.HasPrefix(err.Error(), "The Python download failed: ") ||
			!strings.HasSuffix(err.Error(), "Try again to continue it.") {
			t.Errorf("err = %v", err)
		}

		// What came is kept for the next try.
		if info, err := os.Stat(partial); err != nil || info.Size() != 5000 {
			t.Errorf("partial: %v %v", info, err)
		}
	})

	t.Run("cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		server := httptest.NewServer(&rangeServer{body: body})
		t.Cleanup(server.Close)

		err := downloadFile(ctx, http.DefaultClient, server.URL, filepath.Join(t.TempDir(), "p"), int64(len(body)),
			func(int64) {})
		if !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want cancelled", err)
		}
	})
}
