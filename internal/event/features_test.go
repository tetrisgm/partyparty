package event

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestFeatureDefaultsFilledOnLoad(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	oldMeta := Meta{Title: "old party", Host: "the DJ"}
	data, err := json.Marshal(oldMeta)
	if err != nil {
		t.Fatal(err)
	}
	legacyMeta := filepath.Join(st.Dir(), "meta.json")
	if err := os.WriteFile(legacyMeta, data, 0o644); err != nil {
		t.Fatal(err)
	}

	reloaded, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := reloaded.Meta().Features, FeatureDefaults(); !reflect.DeepEqual(got, want) {
		t.Fatalf("features = %#v, want %#v", got, want)
	}
	if _, err := os.Stat(legacyMeta); !os.IsNotExist(err) {
		t.Fatalf("legacy meta still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(reloaded.Dir(), ".state", "meta.json")); err != nil {
		t.Fatalf("migrated meta missing: %v", err)
	}
}

func TestSetFeaturePersists(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetFeature("requests", true); err != nil {
		t.Fatal(err)
	}
	if err := st.SetFeature("videoUploads", true); err != nil {
		t.Fatal(err)
	}
	if err := st.SetFeature("bogus", true); err == nil {
		t.Fatal("SetFeature accepted an unknown key")
	}

	var meta Meta
	data, err := os.ReadFile(filepath.Join(st.Dir(), ".state", "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	if !meta.Features["requests"] || !meta.Features["videoUploads"] {
		t.Fatalf("persisted features = %#v, want requests/videoUploads on", meta.Features)
	}

	reloaded, err := Open(filepath.Dir(st.Dir()))
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Meta().Features; !got["requests"] || !got["videoUploads"] || !got["uploads"] || !got["comments"] {
		t.Fatalf("reloaded features = %#v", got)
	}
}

func TestSetLinksPersistsAndValidates(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks([]Link{
		{Type: "instagram", URL: "https://instagram.com/dj", Label: "DJ <main>"},
		{Type: "website", URL: "HTTP://DJ.example/Home", Label: ""},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks([]Link{{Type: "website", URL: "javascript:alert(1)", Label: "bad"}}); err == nil {
		t.Fatal("SetLinks accepted a javascript URL")
	}

	var meta Meta
	data, err := os.ReadFile(filepath.Join(st.Dir(), ".state", "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	if len(meta.Links) != 2 {
		t.Fatalf("persisted links = %#v, want 2", meta.Links)
	}
	if meta.Links[0].Label != "Instagram" || meta.Links[0].URL != "https://instagram.com/dj" || meta.Links[0].Type != "instagram" {
		t.Fatalf("first persisted link = %#v", meta.Links[0])
	}
	// The scheme is lowercased; the rest of the URL is left alone.
	if meta.Links[1].Label != "Website" || meta.Links[1].URL != "http://DJ.example/Home" {
		t.Fatalf("second persisted link = %#v, want default Website label and a lowercased scheme", meta.Links[1])
	}

	reloaded, err := Open(filepath.Dir(st.Dir()))
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Meta().Links; len(got) != 2 || got[0].Label != "Instagram" {
		t.Fatalf("reloaded links = %#v", got)
	}
}

func TestProfilePersistsInsideStateDirectory(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	name, bio := "  DJ Luna  ", "  Dance floor specialist  "
	if err := st.SetProfile(&name, &bio); err != nil {
		t.Fatal(err)
	}
	// nil means "leave alone": a save fired from an unhydrated console must
	// not wipe stored truth (entered bios kept resetting exactly this way).
	if err := st.SetProfile(nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := st.Meta(); got.Host != "DJ Luna" || got.Bio != "Dance floor specialist" {
		t.Fatalf("nil-field save clobbered the profile: %#v", got)
	}
	// An explicit empty string still clears deliberately.
	empty := ""
	if err := st.SetProfile(nil, &empty); err != nil {
		t.Fatal(err)
	}
	if got := st.Meta(); got.Bio != "" {
		t.Fatalf("explicit clear did not clear bio: %q", got.Bio)
	}
	if err := st.SetProfile(&name, &bio); err != nil {
		t.Fatal(err)
	}
	// A real image: uploads that do not decode are rejected before publish.
	var avatarBuf bytes.Buffer
	if err := png.Encode(&avatarBuf, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	wantAvatar := avatarBuf.Bytes()
	if _, err := st.SaveAvatar("dj.png", bytes.NewReader(wantAvatar)); err != nil {
		t.Fatal(err)
	}

	meta := st.Meta()
	if meta.Host != "DJ Luna" || meta.Bio != "Dance floor specialist" || meta.Avatar != "/dj-avatar" {
		t.Fatalf("profile meta = %#v", meta)
	}
	avatarPath, ok := st.AvatarPath()
	if !ok {
		t.Fatal("AvatarPath did not find saved profile photo")
	}
	gotAvatar, err := os.ReadFile(avatarPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotAvatar, wantAvatar) {
		t.Fatalf("saved avatar = %q, want %q", gotAvatar, wantAvatar)
	}
	for _, name := range []string{"meta.json", "profile.png"} {
		if _, err := os.Stat(filepath.Join(st.Dir(), ".state", name)); err != nil {
			t.Fatalf("data/%s missing: %v", name, err)
		}
		if _, err := os.Stat(filepath.Join(st.Dir(), name)); !os.IsNotExist(err) {
			t.Fatalf("top-level %s exists: %v", name, err)
		}
	}
	if err := st.RemoveAvatar(); err != nil {
		t.Fatal(err)
	}
	if _, ok := st.AvatarPath(); ok || st.Meta().Avatar != "" {
		t.Fatal("RemoveAvatar left a public avatar")
	}
}
