package event

import (
	"os"
	"strings"
	"testing"
)

func TestDeletedAndHiddenPostsWithdrawTheirMedia(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m, err := st.SaveMedia("p.jpg", strings.NewReader("img"))
	if err != nil {
		t.Fatal(err)
	}
	if st.MediaWithdrawn(m.ID, false) {
		t.Fatal("media not yet attached to a post must stay servable (upload-then-post)")
	}
	p, err := st.AddPost("cid", "Ada", ":)", "", []Media{m}, false)
	if err != nil {
		t.Fatal(err)
	}
	if st.MediaWithdrawn(m.ID, false) {
		t.Fatal("a live post's media was withdrawn")
	}
	if err := st.SetPostState(p.ID, StateHidden); err != nil {
		t.Fatal(err)
	}
	if !st.MediaWithdrawn(m.ID, false) {
		t.Fatal("a hidden post's media is still served to guests")
	}
	if st.MediaWithdrawn(m.ID, true) {
		t.Fatal("the DJ lost access to a hidden post's media")
	}
	if err := st.Delete(p.ID); err != nil {
		t.Fatal(err)
	}
	if !st.MediaWithdrawn(m.ID, true) {
		t.Fatal("a deleted post's media is still served")
	}
}

func TestGuestRosterIsBoundedAndSavedAtomically(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetGuestProfile("a", "Ada", "x"); err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	for i := len(st.guests); i < maxGuests; i++ {
		st.guests[strings.Repeat("g", 1)+string(rune(i))+"-"+itoaTest(i)] = &Guest{}
	}
	st.mu.Unlock()
	if err := st.SetGuestProfile("one-too-many", "Bo", "y"); err == nil {
		t.Fatal("the roster grew past maxGuests")
	}
	if err := st.SetGuestProfile("a", "Ada Renamed", "x"); err != nil {
		t.Fatalf("an existing guest could not update at the cap: %v", err)
	}
	entries, _ := os.ReadDir(dataDir(st.Dir()))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".guests.json.") {
			t.Fatalf("atomic save left a temp file behind: %s", e.Name())
		}
	}
}

func itoaTest(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
