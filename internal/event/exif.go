package event

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
)

// Guest photos are served to every other guest, and phone cameras write the
// shooter's GPS position into them. That told a whole room where each guest
// lives, or at least where they took their last photo before arriving.
//
// Stripping all metadata is the obvious fix and the wrong one: the EXIF
// Orientation tag is how a phone says "this was held sideways", and dropping it
// shows every portrait photo rotated. So this removes LOCATION only:
//
//   - the EXIF GPS IFD is emptied IN PLACE: its entries and every value they
//     point at are zeroed and its entry count set to 0. Nothing changes size, so
//     every other offset in the EXIF block, Orientation included, stays valid.
//   - XMP segments are dropped whole. XMP can repeat the GPS position, and
//     nothing a guest's photo needs lives there.
//
// JPEG only. iOS hands Safari a JPEG for an image upload even when the library
// holds HEIC, so this covers the photos guests actually post. A JPEG whose EXIF
// cannot be parsed loses its EXIF segment entirely: a malformed block is not
// worth keeping at the risk of leaking a location.

const maxScrubBytes = 64 << 20

var (
	exifHeader        = []byte("Exif\x00\x00")
	xmpHeader         = []byte("http://ns.adobe.com/xap/1.0/\x00")
	xmpExtendedHeader = []byte("http://ns.adobe.com/xmp/extension/\x00")
)

// scrubLocationFile removes location metadata from a JPEG on disk. Other files
// are left alone.
func scrubLocationFile(path, origName string) error {
	ext := strings.ToLower(filepath.Ext(origName))
	if ext != ".jpg" && ext != ".jpeg" {
		return nil
	}
	st, err := os.Stat(path)
	if err != nil || st.Size() > maxScrubBytes {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	out, changed := scrubJPEGLocation(data)
	if !changed {
		return nil
	}
	return os.WriteFile(path, out, st.Mode().Perm())
}

// scrubJPEGLocation returns the JPEG with location metadata removed, and
// whether anything changed. Non-JPEG or truncated input comes back unchanged.
func scrubJPEGLocation(in []byte) ([]byte, bool) {
	if len(in) < 4 || in[0] != 0xFF || in[1] != 0xD8 {
		return in, false
	}
	out := make([]byte, 0, len(in))
	out = append(out, in[:2]...)
	changed := false
	i := 2
	for i+4 <= len(in) {
		if in[i] != 0xFF {
			break
		}
		marker := in[i+1]
		// Start of scan: the rest is image data, copied verbatim.
		if marker == 0xDA {
			break
		}
		seglen := int(binary.BigEndian.Uint16(in[i+2 : i+4]))
		end := i + 2 + seglen
		if seglen < 2 || end > len(in) {
			break
		}
		payload := in[i+4 : end]
		if marker == 0xE1 {
			switch {
			case bytes.HasPrefix(payload, xmpHeader), bytes.HasPrefix(payload, xmpExtendedHeader):
				changed = true
				i = end
				continue
			case bytes.HasPrefix(payload, exifHeader):
				seg := append([]byte(nil), in[i:end]...)
				tiff := seg[4+len(exifHeader):]
				ok, did := clearGPS(tiff)
				if !ok {
					changed = true // malformed EXIF: drop it rather than risk a location
					i = end
					continue
				}
				if did {
					changed = true
				}
				out = append(out, seg...)
				i = end
				continue
			}
		}
		out = append(out, in[i:end]...)
		i = end
	}
	out = append(out, in[i:]...)
	if !changed {
		return in, false
	}
	return out, true
}

var exifTypeSize = map[uint16]uint32{1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}

// clearGPS empties the GPS IFD of a TIFF/EXIF block in place. ok is false when
// the block is malformed; did reports whether a GPS IFD was found and cleared.
func clearGPS(t []byte) (ok, did bool) {
	if len(t) < 8 {
		return false, false
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return false, false
	}
	if bo.Uint16(t[2:4]) != 42 {
		return false, false
	}
	ifd0 := bo.Uint32(t[4:8])
	gps, found, valid := findTag(t, bo, ifd0, 0x8825)
	if !valid {
		return false, false
	}
	if !found {
		return true, false
	}
	if uint64(gps)+2 > uint64(len(t)) {
		return false, false
	}
	n := uint32(bo.Uint16(t[gps : gps+2]))
	entries := gps + 2
	if uint64(entries)+uint64(n)*12+4 > uint64(len(t)) {
		return false, false
	}
	for k := uint32(0); k < n; k++ {
		e := entries + k*12
		size := exifTypeSize[bo.Uint16(t[e+2:e+4])] * bo.Uint32(t[e+4:e+8])
		if size > 4 {
			off := bo.Uint32(t[e+8 : e+12])
			if uint64(off)+uint64(size) <= uint64(len(t)) {
				clear(t[off : off+size])
			}
		}
	}
	clear(t[entries : entries+n*12+4])
	bo.PutUint16(t[gps:gps+2], 0)
	return true, true
}

// findTag returns the value field of tag in the IFD at off.
func findTag(t []byte, bo binary.ByteOrder, off uint32, tag uint16) (value uint32, found, valid bool) {
	if uint64(off)+2 > uint64(len(t)) {
		return 0, false, false
	}
	n := uint32(bo.Uint16(t[off : off+2]))
	if uint64(off)+2+uint64(n)*12 > uint64(len(t)) {
		return 0, false, false
	}
	for k := uint32(0); k < n; k++ {
		e := off + 2 + k*12
		if bo.Uint16(t[e:e+2]) == tag {
			return bo.Uint32(t[e+8 : e+12]), true, true
		}
	}
	return 0, false, true
}
