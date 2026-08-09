// Package cloudsync keeps a party's wall and its event page as one timeline.
//
// One link is the promise: the photos posted on the venue Wi-Fi and the ones
// posted from a sofa three days later live in the same place. The Mac is the
// only thing that sees the first kind, so it pushes them up; the web is the
// only thing that sees the second, so it pulls those down.
//
// Everything here fails soft. A party with no internet, no group, or no night
// on tonight is an ordinary party: the wall stays local, guests notice nothing,
// and the sync starts working the moment there is something to sync to. Nothing
// in this package touches audio.
package cloudsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Post is one item of the shared timeline, in the shape the platform stores.
type Post struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	MediaKey  string `json:"mediaKey,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
	CreatedMs int64  `json:"createdMs"`
}

// Binding is the night this party turned out to be, if it is one at all.
type Binding struct {
	Bound  bool   `json:"bound"`
	Slug   string `json:"slug,omitempty"`
	Handle string `json:"handle,omitempty"`
	Title  string `json:"title,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// URL is the event page for a bound night - the one link a DJ hands out.
func (b Binding) URL(base string) string {
	if !b.Bound || b.Handle == "" || b.Slug == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/@" + b.Handle + "/" + b.Slug
}

type Client struct {
	Base      string // https://partyparty.party
	InstallID string
	Secret    string
	HTTP      *http.Client

	mu    sync.Mutex
	since int64
}

func New(base, installID, secret string) *Client {
	return &Client{
		Base:      strings.TrimRight(base, "/"),
		InstallID: installID,
		Secret:    secret,
		HTTP:      &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *Client) ready() bool {
	return c != nil && c.Base != "" && c.InstallID != "" && c.Secret != ""
}

func (c *Client) post(ctx context.Context, path string, body, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("cloudsync: %s: %s", path, response.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(out)
}

// Bind asks which night this party is. A DJ should never have to pair anything
// while a room is filling up, so the answer comes from the group this Mac
// belongs to and the clock.
func (c *Client) Bind(ctx context.Context, partyID string) (Binding, error) {
	if !c.ready() {
		return Binding{}, errors.New("cloudsync: not configured")
	}
	var out Binding
	err := c.post(ctx, "/api/v1/party/bind", map[string]any{
		"id": c.InstallID, "secret": c.Secret, "partyId": partyID,
	}, &out)
	return out, err
}

// Party is the canonical record, as the Mac reads and writes it. The same row
// the web renders - there is no Mac-only kind of party, and a broadcast is a
// capability attached to one of these rather than a thing that becomes one.
type Party struct {
	Key      string `json:"key"`
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	StartsMs int64  `json:"startsMs"`
	Place    string `json:"place"`
	CoverURL string `json:"coverUrl"`
	State    string `json:"state"`
	// PartyID is the live room currently attached, empty when nothing is
	// playing. Durable: it survives the broadcast so the record still says what
	// happened here.
	PartyID string `json:"partyId"`
	URL     string `json:"url"`
	Handle  string `json:"handle"`
}

type partiesResponse struct {
	Linked  bool    `json:"linked"`
	Parties []Party `json:"parties"`
	Group   struct {
		Handle string `json:"handle"`
		Name   string `json:"name"`
	} `json:"group"`
}

type partyResponse struct {
	Linked bool   `json:"linked"`
	Party  Party  `json:"party"`
	Error  string `json:"error"`
}

// Parties lists what this account already has, so the Mac can open a party
// somebody made in a browser. `linked` false means this Mac is not signed in.
func (c *Client) Parties(ctx context.Context) ([]Party, bool, error) {
	if !c.ready() {
		return nil, false, errors.New("cloudsync: not configured")
	}
	var out partiesResponse
	err := c.post(ctx, "/api/v1/parties", map[string]any{
		"id": c.InstallID, "secret": c.Secret,
	}, &out)
	return out.Parties, out.Linked, err
}

// NewParty is a party as somebody types it, on either client. The web form has
// exactly these fields, so the booth asks exactly these questions - creating a
// party is one thing that happens to have two front doors.
type NewParty struct {
	Title string
	Place string
	// Comma separated, as typed. They become people on the account, which is
	// what makes "who played" a history rather than a label on one night.
	DJs      string
	StartsMs int64
	// The live room, when this party is being opened to broadcast right now.
	PartyID string
}

// CreateParty makes a canonical party through the platform's own creation path
// - the same one the web form calls. PartyID attaches the live room at creation
// so starting a broadcast never mints a second record.
func (c *Client) CreateParty(ctx context.Context, p NewParty) (Party, error) {
	if !c.ready() {
		return Party{}, errors.New("cloudsync: not configured")
	}
	var out partyResponse
	body := map[string]any{
		"id": c.InstallID, "secret": c.Secret, "title": p.Title, "place": p.Place,
		"djs": p.DJs,
	}
	if p.PartyID != "" {
		body["partyId"] = p.PartyID
	}
	if p.StartsMs > 0 {
		body["startsMs"] = p.StartsMs
	}
	if err := c.post(ctx, "/api/v1/party/create", body, &out); err != nil {
		return Party{}, err
	}
	if !out.Linked {
		return Party{}, errNotSignedIn
	}
	return out.Party, nil
}

// UpdateParty edits one. Only the fields passed move; nil leaves them alone, so
// the Mac writing a start time cannot blank a place typed on the web.
func (c *Client) UpdateParty(ctx context.Context, key string, fields map[string]any) (Party, error) {
	if !c.ready() {
		return Party{}, errors.New("cloudsync: not configured")
	}
	body := map[string]any{"id": c.InstallID, "secret": c.Secret, "partyKey": key}
	for k, v := range fields {
		body[k] = v
	}
	var out partyResponse
	if err := c.post(ctx, "/api/v1/party/update", body, &out); err != nil {
		return Party{}, err
	}
	if !out.Linked {
		return Party{}, errNotSignedIn
	}
	return out.Party, nil
}

// errNotSignedIn is this Mac having no account behind it. An ordinary state,
// not a failure: nothing to list, nothing to write to.
var errNotSignedIn = errors.New("this Mac is not signed in")

// NotSignedIn reports that error without exporting the sentinel's identity.
func NotSignedIn(err error) bool { return errors.Is(err, errNotSignedIn) }

// Profile is the DJ, as both the console and the web show them. One record:
// the Mac reads it so a paired console opens as whoever the DJ already is, and
// writes it so an edit made in the booth is the same edit made on the site.
type Profile struct {
	Handle    string            `json:"handle,omitempty"`
	Name      string            `json:"name,omitempty"`
	Bio       string            `json:"bio,omitempty"`
	Links     map[string]string `json:"links,omitempty"`
	AvatarURL string            `json:"avatarUrl,omitempty"`
	UpdatedMs int64             `json:"updatedMs,omitempty"`
}

type profileResponse struct {
	Linked  bool    `json:"linked"`
	Profile Profile `json:"profile"`
}

// Profile reads the paired DJ's profile. `linked` false means this Mac belongs
// to no group, which is an ordinary state and not an error: the console keeps
// whatever it has locally.
func (c *Client) Profile(ctx context.Context) (Profile, bool, error) {
	if !c.ready() {
		return Profile{}, false, errors.New("cloudsync: not configured")
	}
	var out profileResponse
	err := c.post(ctx, "/api/v1/install/profile", map[string]any{
		"id": c.InstallID, "secret": c.Secret,
	}, &out)
	return out.Profile, out.Linked, err
}

// PushProfile sends a local edit up. The platform keeps its own copy if that
// copy is newer, so this is safe to call on every change without a lock across
// two machines - and the answer is always what the record now says.
func (c *Client) PushProfile(ctx context.Context, p Profile) (Profile, bool, error) {
	if !c.ready() {
		return Profile{}, false, errors.New("cloudsync: not configured")
	}
	var out profileResponse
	err := c.post(ctx, "/api/v1/install/profile", map[string]any{
		"id": c.InstallID, "secret": c.Secret, "updatedMs": p.UpdatedMs,
		"set": map[string]any{
			"name": p.Name, "bio": p.Bio,
			"instagram": p.Links["instagram"], "soundcloud": p.Links["soundcloud"],
			"website": p.Links["website"],
		},
	}, &out)
	return out.Profile, out.Linked, err
}

// PushAvatar sends the photo itself. Separate from PushProfile because it is
// bytes rather than JSON, and because a picture is the one field somebody
// changes without touching anything else.
func (c *Client) PushAvatar(ctx context.Context, filename string, image []byte) (string, error) {
	if !c.ready() {
		return "", errors.New("cloudsync: not configured")
	}
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	_ = form.WriteField("id", c.InstallID)
	_ = form.WriteField("secret", c.Secret)
	if len(image) == 0 {
		_ = form.WriteField("clear", "1")
	} else {
		part, err := form.CreateFormFile("avatar", filename)
		if err != nil {
			return "", err
		}
		if _, err := part.Write(image); err != nil {
			return "", err
		}
	}
	if err := form.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.Base+"/api/v1/install/avatar", bytes.NewReader(buf.Bytes()))
	if err != nil {
		return "", err
	}
	request.Header.Set("content-type", form.FormDataContentType())
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("cloudsync: avatar: %s", response.Status)
	}
	var out struct {
		AvatarURL string `json:"avatarUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.AvatarURL, nil
}

// FetchImage pulls a picture the platform holds, so a console that has just
// been paired shows the DJ's real photo rather than an empty disc.
func (c *Client) FetchImage(ctx context.Context, url string) ([]byte, string, error) {
	if url == "" {
		return nil, "", errors.New("cloudsync: no image")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("cloudsync: image: %s", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, "", err
	}
	return body, response.Header.Get("content-type"), nil
}

type syncResponse struct {
	Bound  bool   `json:"bound"`
	Stored int    `json:"stored"`
	Posts  []Post `json:"posts"`
}

// Sync pushes what the room wrote and returns what the web wrote since last
// time. Pushing is idempotent by post id, so a retry after a dropped
// connection costs nothing and duplicates nothing - which is what makes it
// safe to just try again on a venue's bad Wi-Fi.
func (c *Client) Sync(ctx context.Context, partyID, joinURL string, outgoing []Post) ([]Post, error) {
	if !c.ready() {
		return nil, errors.New("cloudsync: not configured")
	}
	c.mu.Lock()
	since := c.since
	c.mu.Unlock()

	var out syncResponse
	if err := c.post(ctx, "/api/v1/party/posts", map[string]any{
		"id": c.InstallID, "secret": c.Secret, "partyId": partyID,
		"joinUrl": joinURL, "posts": outgoing, "since": since,
	}, &out); err != nil {
		return nil, err
	}
	if !out.Bound {
		return nil, nil
	}
	// Advance only past what actually arrived. Moving the cursor to "now" would
	// skip anything written while the request was in flight, and those posts
	// would never be seen again.
	newest := since
	for _, post := range out.Posts {
		if post.CreatedMs > newest {
			newest = post.CreatedMs
		}
	}
	c.mu.Lock()
	if newest > c.since {
		c.since = newest
	}
	c.mu.Unlock()
	return out.Posts, nil
}

// Since reports the cursor, so a restart can resume rather than replay.
func (c *Client) Since() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.since
}

// Resume restores a cursor persisted across launches.
func (c *Client) Resume(since int64) {
	c.mu.Lock()
	if since > c.since {
		c.since = since
	}
	c.mu.Unlock()
}

// Hooks are the party, supplied as functions so this package never imports the
// event store and the store never learns how it reaches the cloud.
type Hooks struct {
	PartyID func() string
	Live    func() bool
	// JoinURL is the link a guest opens to hear this room. It travels with the
	// timeline sync rather than on a channel of its own, so the platform learns
	// where to send a listener at exactly the moments it learns the room is
	// still playing - one heartbeat, one truth.
	JoinURL  func() string
	Outgoing func(limit int) []Post
	Merge    func(id, author, body string, createdMs int64) (bool, error)
	Bound    func(url string)
	Logf     func(format string, args ...any)
}

// ProfileHooks are the DJ's own record, supplied the same way: this package
// knows how to reach the platform and nothing about where a Mac keeps a face.
type ProfileHooks struct {
	Local func() Profile
	Apply func(Profile) (bool, error)
	// The photo on this Mac, and where to put one that came from the platform.
	// AvatarSeen is the last URL applied, so an unchanged picture is not
	// downloaded once a minute for the length of a party.
	LocalAvatar func() (name string, data []byte, ok bool)
	AvatarSeen  func() string
	ApplyAvatar func(url, contentType string, data []byte) error
	Logf        func(format string, args ...any)
}

// SyncProfile reconciles the DJ's profile once. Newer wins, whichever side
// that is; equal stamps mean nothing to do, which is almost every call.
func (c *Client) SyncProfile(ctx context.Context, h ProfileHooks) error {
	if !c.ready() || h.Local == nil {
		return nil
	}
	local := h.Local()
	remote, linked, err := c.Profile(ctx)
	if err != nil || !linked {
		return err
	}

	if local.UpdatedMs > remote.UpdatedMs {
		// This Mac saw the last edit. Send it, and the photo with it - the
		// picture is part of the profile, not a separate opinion about it.
		if h.LocalAvatar != nil {
			if name, data, ok := h.LocalAvatar(); ok {
				if _, err := c.PushAvatar(ctx, name, data); err != nil && h.Logf != nil {
					h.Logf("cloudsync: profile photo: %v", err)
				}
			}
		}
		_, _, err := c.PushProfile(ctx, local)
		return err
	}

	if _, err := h.Apply(remote); err != nil {
		return err
	}
	// The photo, only when it is one we have not already taken.
	if remote.AvatarURL != "" && h.ApplyAvatar != nil &&
		(h.AvatarSeen == nil || h.AvatarSeen() != remote.AvatarURL) {
		data, contentType, err := c.FetchImage(ctx, remote.AvatarURL)
		if err != nil {
			return err
		}
		return h.ApplyAvatar(remote.AvatarURL, contentType, data)
	}
	return nil
}

// RunProfile keeps the profile in step for as long as the app is running -
// deliberately NOT gated on a party being live, because a DJ sets their name
// and photo up long before they press Go Live, and the console should already
// know them when they do.
func (c *Client) RunProfile(ctx context.Context, h ProfileHooks, every time.Duration) {
	if every <= 0 {
		every = 60 * time.Second
	}
	for {
		if err := c.SyncProfile(ctx, h); err != nil && h.Logf != nil {
			h.Logf("cloudsync: profile: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// Run keeps the timeline in step for as long as a party is playing. It is
// quiet by construction: no party, no internet, no group, or no night on
// tonight all mean it does nothing at all and says nothing about it. A party
// must never look broken because the cloud is.
func (c *Client) Run(ctx context.Context, h Hooks, every time.Duration) {
	if every <= 0 {
		every = 20 * time.Second
	}
	logf := h.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	var boundParty string
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
		if !c.ready() || h.PartyID == nil || (h.Live != nil && !h.Live()) {
			continue
		}
		partyID := h.PartyID()
		if partyID == "" {
			continue
		}
		// Ask once per party which night this is. Asking every tick would
		// rewrite the binding of a night another Mac has since claimed.
		if partyID != boundParty {
			binding, err := c.Bind(ctx, partyID)
			if err != nil {
				continue
			}
			boundParty = partyID
			if binding.Bound {
				logf("cloudsync: this party is %s", binding.URL(c.Base))
				if h.Bound != nil {
					h.Bound(binding.URL(c.Base))
				}
			}
		}
		var outgoing []Post
		if h.Outgoing != nil {
			outgoing = h.Outgoing(100)
		}
		var joinURL string
		if h.JoinURL != nil {
			joinURL = h.JoinURL()
		}
		incoming, err := c.Sync(ctx, partyID, joinURL, outgoing)
		if err != nil {
			logf("cloudsync: %v", err)
			continue
		}
		for _, post := range incoming {
			if h.Merge == nil {
				break
			}
			if _, err := h.Merge(post.ID, post.Author, post.Body, post.CreatedMs); err != nil {
				logf("cloudsync: could not merge %s: %v", post.ID, err)
			}
		}
	}
}
