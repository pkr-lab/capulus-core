package gate

import (
	"regexp"
	"strings"
)

var (
	localPart = regexp.MustCompile(`^[a-z0-9_%+'-]+(\.[a-z0-9_%+'-]+)*$`)
	domainLbl = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	tldLabel  = regexp.MustCompile(`^([a-z]{2,63}|xn--[a-z0-9-]{2,59})$`)
)

func NormalizeEmail(raw string) (string, bool) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if len(email) < 6 || len(email) > 254 {
		return "", false
	}
	at := strings.LastIndex(email, "@")
	if at < 1 || strings.Count(email, "@") != 1 {
		return "", false
	}
	local, domain := email[:at], email[at+1:]
	if len(local) > 64 || !localPart.MatchString(local) {
		return "", false
	}
	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return "", false
	}
	for i, l := range labels {
		if i == len(labels)-1 {
			if !tldLabel.MatchString(l) {
				return "", false
			}
			continue
		}
		if !domainLbl.MatchString(l) {
			return "", false
		}
	}
	return email, true
}
