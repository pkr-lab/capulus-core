package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"ticket-gate/internal/config"
	"ticket-gate/internal/gate"
	"ticket-gate/internal/mail"
	"ticket-gate/internal/zammad"
)

func main() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		slog.New(slog.NewJSONHandler(os.Stdout, nil)).Error("invalid configuration", "error", err.Error())
		os.Exit(1)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(logger)

	svc := gate.NewService(gate.Deps{
		Config:  cfg,
		Mailer:  mail.NewSMTP(cfg.SMTP, time.Now),
		Tickets: zammad.New(cfg.Zammad),
		Logger:  logger,
	})

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           svc.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				svc.Purge()
			}
		}
	}()

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("ticket-gate listening", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case err := <-serverErr:
		logger.Error("server exited with error", "error", err.Error())
		os.Exit(1)
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown failed", "error", err.Error())
	}
}
