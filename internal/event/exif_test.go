package event

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// buildJPEG makes a minimal JPEG: an EXIF block with Orientation=6 and a GPS
// IFD holding a latitude, an XMP segment, then scan data.
func buildJPEG(t *testing.T) []byte {
	t.Helper()
	le := binary.LittleEndian
	tiff := make([]byte, 0, 128)
	tiff = append(tiff, 'I', 'I', 42, 0, 8, 0, 0, 0)
	// IFD0 at 8: 2 entries
	ifd0 := make([]byte, 2+2*12+4)
	le.PutUint16(ifd0[0:], 2)
	le.PutUint16(ifd0[2:], 0x0112) // Orientation
	le.PutUint16(ifd0[4:], 3)
	le.PutUint32(ifd0[6:], 1)
	le.PutUint16(ifd0[10:], 6)
	gpsOff := uint32(8 + len(ifd0))
	le.PutUint16(ifd0[14:], 0x8825) // GPS IFD pointer
	le.PutUint16(ifd0[16:], 4)
	le.PutUint32(ifd0[18:], 1)
	le.PutUint32(ifd0[22:], gpsOff)
	tiff = append(tiff, ifd0...)
	// GPS IFD: LatitudeRef "N" inline, Latitude 3 rationals at an offset
	gps := make([]byte, 2+2*12+4)
	le.PutUint16(gps[0:], 2)
	le.PutUint16(gps[2:], 1)
	le.PutUint16(gps[4:], 2)
	le.PutUint32(gps[6:], 2)
	copy(gps[10:], "N\x00")
	latOff := gpsOff + uint32(len(gps))
	le.PutUint16(gps[14:], 2)
	le.PutUint16(gps[16:], 5)
	le.PutUint32(gps[18:], 3)
	le.PutUint32(gps[22:], latOff)
	tiff = append(tiff, gps...)
	lat := make([]byte, 24)
	for i := range lat {
		lat[i] = 0x37
	}
	tiff = append(tiff, lat...)

	seg := func(marker byte, payload []byte) []byte {
		b := []byte{0xFF, marker, 0, 0}
		binary.BigEndian.PutUint16(b[2:], uint16(len(payload)+2))
		return append(b, payload...)
	}
	var out bytes.Buffer
	out.Write([]byte{0xFF, 0xD8})
	out.Write(seg(0xE1, append(append([]byte(nil), exifHeader...), tiff...)))
	out.Write(seg(0xE1, append(append([]byte(nil), xmpHeader...), []byte(`<exif:GPSLatitude>37,46N</exif:GPSLatitude>`)...)))
	out.Write([]byte{0xFF, 0xDA, 0, 4, 1, 2, 0xAA, 0xBB, 0xFF, 0xD9})
	return out.Bytes()
}

func TestScrubRemovesLocationAndKeepsOrientation(t *testing.T) {
	in := buildJPEG(t)
	out, changed := scrubJPEGLocation(append([]byte(nil), in...))
	if !changed {
		t.Fatal("nothing was scrubbed")
	}
	if bytes.Contains(out, []byte("GPSLatitude")) {
		t.Fatal("XMP location survived")
	}
	if bytes.Contains(out, bytes.Repeat([]byte{0x37}, 24)) {
		t.Fatal("GPS latitude bytes survived")
	}
	if !bytes.HasSuffix(out, []byte{0xFF, 0xDA, 0, 4, 1, 2, 0xAA, 0xBB, 0xFF, 0xD9}) {
		t.Fatal("image data was altered")
	}
	i := bytes.Index(out, exifHeader)
	tiff := out[i+len(exifHeader):]
	le := binary.LittleEndian
	orient, found, ok := findTag(tiff, le, 8, 0x0112)
	if !ok || !found || uint16(orient) != 6 {
		t.Fatalf("Orientation lost: found=%v value=%d; photos would show rotated", found, uint16(orient))
	}
	gps, found, _ := findTag(tiff, le, 8, 0x8825)
	if !found || le.Uint16(tiff[gps:]) != 0 {
		t.Fatal("GPS IFD still has entries")
	}
}

func TestScrubLeavesCleanFilesAlone(t *testing.T) {
	plain := []byte{0xFF, 0xD8, 0xFF, 0xDA, 0, 4, 1, 2, 0xAA, 0xFF, 0xD9}
	if out, changed := scrubJPEGLocation(plain); changed || !bytes.Equal(out, plain) {
		t.Fatal("a JPEG with no metadata was modified")
	}
	if _, changed := scrubJPEGLocation([]byte("not a jpeg")); changed {
		t.Fatal("non-JPEG input was modified")
	}
}

func TestSaveMediaStoresTheScrubbedPhoto(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m, err := st.SaveMedia("IMG_0001.JPG", bytes.NewReader(buildJPEG(t)))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(st.Dir(), m.ID))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, bytes.Repeat([]byte{0x37}, 24)) || bytes.Contains(data, []byte("GPSLatitude")) {
		t.Fatal("the stored guest photo still carries a location")
	}
	if m.Size != int64(len(data)) {
		t.Fatalf("Media.Size = %d, file is %d bytes", m.Size, len(data))
	}
}
