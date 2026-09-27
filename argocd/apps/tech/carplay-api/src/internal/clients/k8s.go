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

type K8sConfigMapClient struct {
	apiServer  string
	token      string
	httpClient *http.Client
}

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
