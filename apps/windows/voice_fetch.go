package main

// The Python download for spoken lines: fetched with net/http (resumed
// with a Range request), checked against the lock's sha256 and unpacked
// with Go's own archive/tar and compress/gzip, so the exe needs neither
// Windows's tar.exe (Windows 10 1803 and later) nor anything else.
// Platform-neutral (voice_fetch_test.go).

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	// pythonMarker, in the unpacked python/, holds the archive's sha256:
	// the Python there is the lock's.
	pythonMarker = ".kinetic-python"
	// pythonExe is the interpreter's place in python-build-standalone's
	// install_only archives for Windows.
	pythonExe = "python.exe"
)

// downloadFile fetches url into partial until it holds size bytes,
// continuing what an earlier run left there with a Range request; a
// server that sends the whole file instead starts it again. progress gets
// the bytes held after each read. It returns ctx.Err() when cancelled, and
// otherwise an error worded for the reader; partial keeps what came.
func downloadFile(ctx context.Context, client *http.Client, url, partial string, size int64,
	progress func(have int64)) error {
	have := fileSize(partial)
	if have > size {
		_ = os.Remove(partial)
		have = 0
	}

	if have == size {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(partial), 0o755); err != nil {
		return fmt.Errorf("The Python download cannot be saved: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return errors.New("The Python download's address is not valid.")
	}

	req.Header.Set("User-Agent", "kinetic-voice")

	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}

	resp, err := client.Do(req)
	if err != nil {
		return failed(ctx, err)
	}

	defer resp.Body.Close()

	flags := os.O_WRONLY | os.O_CREATE

	switch {
	case resp.StatusCode == http.StatusPartialContent && have > 0:
		flags |= os.O_APPEND
	case resp.StatusCode == http.StatusOK:
		flags |= os.O_TRUNC
		have = 0
	default:
		return fmt.Errorf("The Python download failed (HTTP %d).", resp.StatusCode)
	}

	file, err := os.OpenFile(partial, flags, 0o644)
	if err != nil {
		return fmt.Errorf("The Python download cannot be saved: %w", err)
	}

	defer file.Close()

	buf := make([]byte, 256<<10)

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := file.Write(buf[:n]); err != nil {
				return fmt.Errorf("The Python download cannot be saved: %w", err)
			}

			have += int64(n)
			progress(have)
		}

		if errors.Is(readErr, io.EOF) {
			break
		}

		if readErr != nil {
			return failed(ctx, readErr)
		}

		if have > size {
			return fmt.Errorf("The Python download is larger than the %d bytes it should be. Try again.", size)
		}
	}

	if have != size {
		return fmt.Errorf("The Python download stopped at %d of %d bytes. Try again to continue it.", have, size)
	}

	return file.Close()
}

// failed is a network failure in the reader's words, or the cancel.
func failed(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}

	return fmt.Errorf("The Python download failed: %v. Try again to continue it.", err)
}

// fileSize is a file's size, 0 when it is not there.
func fileSize(name string) int64 {
	info, err := os.Stat(name)
	if err != nil {
		return 0
	}

	return info.Size()
}

// sha256File is a file's sha256 in hex.
func sha256File(name string) (string, error) {
	file, err := os.Open(name)
	if err != nil {
		return "", err
	}

	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

// unpackPython checks archive against sha and unpacks it into
// root\python (through root\python.partial, so a failure leaves no half
// Python), marking it with the sha; the archive goes, and its downloads
// folder too when nothing else is in it. A mismatched archive is deleted.
func unpackPython(archive, sha, root string) error {
	digest, err := sha256File(archive)
	if err != nil {
		return errors.New("The Python download cannot be read.")
	}

	if digest != sha {
		_ = os.Remove(archive)

		return errors.New("The Python download did not match its checksum, so it was deleted. Try again.")
	}

	staging := filepath.Join(root, "python.partial")
	_ = os.RemoveAll(staging)

	fail := func(err error) error {
		_ = os.RemoveAll(staging)

		return err
	}

	if err := extractTarGz(archive, staging); err != nil {
		return fail(fmt.Errorf("Python could not be unpacked: %w", err))
	}

	unpacked := filepath.Join(staging, "python")
	if info, err := os.Stat(filepath.Join(unpacked, pythonExe)); err != nil || !info.Mode().IsRegular() {
		return fail(errors.New(`The Python download holds no python\python.exe.`))
	}

	if err := os.WriteFile(filepath.Join(unpacked, pythonMarker), []byte(sha), 0o644); err != nil {
		return fail(fmt.Errorf("Python could not be unpacked: %w", err))
	}

	target := filepath.Join(root, "python")
	_ = os.RemoveAll(target)

	if err := os.Rename(unpacked, target); err != nil {
		return fail(fmt.Errorf("Python could not be unpacked: %w", err))
	}

	_ = os.RemoveAll(staging)
	_ = os.Remove(archive)
	// downloads/ is the helper's too: removed only when empty.
	_ = os.Remove(filepath.Dir(archive))

	return nil
}

// extractTarGz unpacks a .tar.gz into dir: folders, files (keeping their
// executable bit), and links that stay inside dir. A name or link that
// would reach outside dir fails the whole archive.
func extractTarGz(archive, dir string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}

	defer file.Close()

	gz, err := gzip.NewReader(file)
	if err != nil {
		return err
	}

	defer gz.Close()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	tr := tar.NewReader(gz)

	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}

		if err != nil {
			return err
		}

		name, ok := insideName(h.Name)
		if !ok {
			return fmt.Errorf("the archive's %s is outside its folder", h.Name)
		}

		if name == "." {
			continue
		}

		target := filepath.Join(dir, filepath.FromSlash(name))

		switch h.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(target, 0o755)
		case tar.TypeReg:
			err = writeEntry(target, tr, h.FileInfo().Mode())
		case tar.TypeSymlink:
			if _, ok := insideName(path.Join(path.Dir(name), h.Linkname)); !ok || path.IsAbs(h.Linkname) ||
				strings.ContainsAny(h.Linkname, `\:`) {
				return fmt.Errorf("the archive's %s links outside its folder", h.Name)
			}

			if err = os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
				err = os.Symlink(filepath.FromSlash(h.Linkname), target)
			}
		case tar.TypeLink:
			source, ok := insideName(h.Linkname)
			if !ok {
				return fmt.Errorf("the archive's %s links outside its folder", h.Name)
			}

			err = copyEntry(filepath.Join(dir, filepath.FromSlash(source)), target)
		default:
			// Devices, FIFOs and global headers: nothing a Python needs.
		}

		if err != nil {
			return err
		}
	}
}

// insideName is an archive member's name cleaned, and whether it stays
// inside the archive's folder (no absolute path, no "..", no drive or
// backslash, which Windows would read as a path of its own).
func insideName(name string) (string, bool) {
	if name == "" || strings.ContainsAny(name, `\:`) || path.IsAbs(name) {
		return "", false
	}

	clean := path.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}

	return clean, true
}

// writeEntry writes one archive file, executable when the archive says so.
func writeEntry(target string, r io.Reader, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}

	perm := os.FileMode(0o644)
	if mode&0o111 != 0 {
		perm = 0o755
	}

	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}

	if _, err := io.Copy(out, r); err != nil {
		_ = out.Close()

		return err
	}

	return out.Close()
}

// copyEntry makes a hard-linked archive member a copy of the file it
// names.
func copyEntry(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}

	defer in.Close()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	return writeEntry(target, in, info.Mode())
}

// isExecutable reports whether path is a file the exe can run: a regular
// file, with an executable bit outside Windows.
func isExecutable(name string) bool {
	info, err := os.Stat(name)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}

	return runtime.GOOS == "windows" || info.Mode()&0o111 != 0
}
