package clients

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// K8sConfigMapClient reads a single ConfigMap key via the in-cluster API
// using this pod's own ServiceAccount token — no client-go dependency (this
// binary otherwise has zero Kubernetes API surface, see
// docs/3-apps-workloads/300d0-carplay-api.md "power-agent" section on why
// it stays unprivileged). Mirrors the
// same minimal approach github-release-watcher's Python watcher already
// uses for its own state ConfigMap (argocd/apps/workloads/github-release-watcher/
// templates/configmap.yaml).
//
// Needs the RoleBinding granting this pod's ServiceAccount `get` on that
// specific ConfigMap in its namespace — see
// argocd/apps/workloads/github-release-watcher/templates/role.yaml
// ("...-updates-reader").
type K8sConfigMapClient struct {
	apiServer  string
	token      string
	httpClient *http.Client
}

// NewK8sConfigMapClient fails if not actually running in-cluster (no
// mounted ServiceAccount token, or KUBERNETES_SERVICE_HOST/PORT unset) —
// callers treat that as "feature unavailable" rather than a fatal startup
// error, same degrade-don't-crash approach as every other upstream in this
// service.
func NewK8sConfigMapClient() (*K8sConfigMapClient, error) {
	const saDir = "/var/run/secrets/kubernetes.io/serviceaccount"

	tokenBytes, err := os.ReadFile(saDir + "/token")
	if err != nil {
		return nil, fmt.Errorf("reading service account token: %w", err)
	}

	caCert, err := os.ReadFile(saDir + "/ca.crt")
	if err != nil {
		return nil, fmt.Errorf("reading service account CA cert: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("parsing service account CA cert: no valid certificates found")
	}

	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, fmt.Errorf("KUBERNETES_SERVICE_HOST/KUBERNETES_SERVICE_PORT not set — not running in-cluster")
	}

	return &K8sConfigMapClient{
		apiServer: fmt.Sprintf("https://%s:%s", host, port),
		token:     strings.TrimSpace(string(tokenBytes)),
		httpClient: &http.Client{
			Timeout: 3 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{RootCAs: pool},
			},
		},
	}, nil
}

// GetConfigMapData fetches one .data key from a ConfigMap in the given
// namespace. Returns "" (no error) if the key is absent from an otherwise
// successfully-fetched ConfigMap.
func (c *K8sConfigMapClient) GetConfigMapData(ctx context.Context, namespace, name, key string) (string, error) {
	endpoint := fmt.Sprintf("%s/api/v1/namespaces/%s/configmaps/%s", c.apiServer, namespace, name)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("querying k8s api: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("k8s api returned %d for configmap %s/%s", resp.StatusCode, namespace, name)
	}

	var parsed struct {
		Data map[string]string `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("decoding configmap response: %w", err)
	}
	return parsed.Data[key], nil
}
