// ppmail drains the platform's outbox and sends it through MXroute.
//
// It lives on the origin box rather than in the Worker for one reason: Workers
// are a poor place to speak SMTP and a worse place to keep the password for a
// mailbox. The Worker only ever writes rows; this comes and takes them, sends
// them, and says which ones landed. Every send leaves a line in the log, so
// "did that invitation go out" has an answer.
//
// It is a service, not a script: run it under systemd on the box. It does
// nothing on its own until it is installed and given credentials.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"mime"
	"net/http"
	"net/smtp"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type message struct {
	ID        string `json:"id"`
	To        string `json:"to_email"`
	Subject   string `json:"subject"`
	BodyText  string `json:"body_text"`
	Headers   string `json:"headers"`
	AttachICS string `json:"attach_ics"`
}

type failure struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

type drainRequest struct {
	Key    string    `json:"key"`
	Sent   []string  `json:"sent,omitempty"`
	Failed []failure `json:"failed,omitempty"`
}

type drainResponse struct {
	Messages []message `json:"messages"`
}

type config struct {
	outboxURL string
	outboxKey string
	host      string
	port      string
	user      string
	pass      string
	from      string
	fromName  string
	interval  time.Duration
}

func loadConfig() (config, error) {
	cfg := config{
		outboxURL: os.Getenv("PP_OUTBOX_URL"),
		outboxKey: os.Getenv("PP_OUTBOX_KEY"),
		host:      os.Getenv("PP_SMTP_HOST"),
		port:      envOr("PP_SMTP_PORT", "587"),
		user:      os.Getenv("PP_SMTP_USER"),
		pass:      os.Getenv("PP_SMTP_PASS"),
		from:      os.Getenv("PP_MAIL_FROM"),
		fromName:  envOr("PP_MAIL_FROM_NAME", "PartyParty"),
		interval:  30 * time.Second,
	}
	var missing []string
	for name, value := range map[string]string{
		"PP_OUTBOX_URL": cfg.outboxURL, "PP_OUTBOX_KEY": cfg.outboxKey,
		"PP_SMTP_HOST": cfg.host, "PP_SMTP_USER": cfg.user,
		"PP_SMTP_PASS": cfg.pass, "PP_MAIL_FROM": cfg.from,
	} {
		if strings.TrimSpace(value) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return cfg, fmt.Errorf("missing: %s", strings.Join(missing, ", "))
	}
	return cfg, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

// buildMessage renders one RFC 5322 message. The headers the Worker stored
// travel through verbatim - List-Unsubscribe among them, which is what makes
// the one-click unsubscribe in a mail client work at all - and anything that
// tries to inject a second header by smuggling a newline is dropped rather
// than escaped, because there is no legitimate newline in a subject.
func buildMessage(cfg config, m message) ([]byte, error) {
	if strings.ContainsAny(m.To, "\r\n") || !strings.Contains(m.To, "@") {
		return nil, fmt.Errorf("refusing a malformed recipient")
	}
	extra := map[string]string{}
	if strings.TrimSpace(m.Headers) != "" {
		if err := json.Unmarshal([]byte(m.Headers), &extra); err != nil {
			return nil, fmt.Errorf("headers: %w", err)
		}
	}

	var buf bytes.Buffer
	write := func(name, value string) {
		if strings.ContainsAny(name, "\r\n:") || strings.ContainsAny(value, "\r\n") {
			return
		}
		fmt.Fprintf(&buf, "%s: %s\r\n", name, value)
	}
	write("From", fmt.Sprintf("%s <%s>", mime.QEncoding.Encode("utf-8", cfg.fromName), cfg.from))
	write("To", m.To)
	write("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	write("Date", time.Now().UTC().Format(time.RFC1123Z))
	write("MIME-Version", "1.0")
	write("Content-Type", "text/plain; charset=utf-8")
	write("Content-Transfer-Encoding", "8bit")
	for name, value := range extra {
		write(name, value)
	}
	buf.WriteString("\r\n")
	buf.WriteString(strings.ReplaceAll(m.BodyText, "\n", "\r\n"))
	buf.WriteString("\r\n")
	return buf.Bytes(), nil
}

type sender interface {
	send(cfg config, m message) error
}

type smtpSender struct{}

func (smtpSender) send(cfg config, m message) error {
	body, err := buildMessage(cfg, m)
	if err != nil {
		return err
	}
	auth := smtp.PlainAuth("", cfg.user, cfg.pass, cfg.host)
	return smtp.SendMail(cfg.host+":"+cfg.port, auth, cfg.from, []string{m.To}, body)
}

// drain reports the previous round's results and collects the next batch. The
// two are one request on purpose: a sender that reports separately can crash
// between sending and reporting, and the message goes out twice.
func drain(ctx context.Context, client *http.Client, cfg config, sent []string, failed []failure) ([]message, error) {
	payload, err := json.Marshal(drainRequest{Key: cfg.outboxKey, Sent: sent, Failed: failed})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.outboxURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("outbox: %s", response.Status)
	}
	var decoded drainResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	return decoded.Messages, nil
}

func runOnce(ctx context.Context, client *http.Client, cfg config, out sender, sent []string, failed []failure) ([]string, []failure) {
	messages, err := drain(ctx, client, cfg, sent, failed)
	if err != nil {
		log.Printf("ppmail: outbox unreachable: %v", err)
		// Keep the unreported results: the next round tells the truth rather
		// than losing which messages already went out.
		return sent, failed
	}
	nextSent := make([]string, 0, len(messages))
	nextFailed := make([]failure, 0)
	for _, m := range messages {
		if err := out.send(cfg, m); err != nil {
			log.Printf("ppmail: %s to %s failed: %v", m.ID, m.To, err)
			nextFailed = append(nextFailed, failure{ID: m.ID, Error: err.Error()})
			continue
		}
		log.Printf("ppmail: sent %s to %s", m.ID, m.To)
		nextSent = append(nextSent, m.ID)
	}
	return nextSent, nextFailed
}

func main() {
	once := flag.Bool("once", false, "drain a single batch and exit")
	flag.Parse()

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("ppmail: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client := &http.Client{Timeout: 20 * time.Second}
	var sent []string
	var failed []failure
	for {
		sent, failed = runOnce(ctx, client, cfg, smtpSender{}, sent, failed)
		if *once {
			// Report the final round before leaving, or the last batch is sent
			// but never marked and goes out again on the next start.
			if len(sent) > 0 || len(failed) > 0 {
				if _, err := drain(ctx, client, cfg, sent, failed); err != nil {
					log.Printf("ppmail: final report failed: %v", err)
				}
			}
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(cfg.interval):
		}
	}
}
