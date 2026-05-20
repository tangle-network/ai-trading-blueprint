# Infra / containers / clouds / k8s. CLI surface only — daemons (docker,
# k3s etc.) come from the host OS.
{ pkgs, lib }:

with pkgs; [
  # Container clients.
  docker-client
  docker-compose
  docker-buildx
  podman
  buildah
  skopeo
  dive
  trivy

  # k8s.
  kubectl
  kubernetes-helm
  k9s
  kustomize
  kind
  k3d
  argocd

  # IaC.
  terraform
  opentofu
  pulumi
  ansible
  vagrant
  packer

  # Clouds.
  awscli2
  google-cloud-sdk
  azure-cli
  doctl
  flyctl
  railway
  scaleway-cli

  # Service mesh / RPC.
  grpcurl
  buf

  # Cert / secrets.
  step-cli
  vault
  sops
  age
]
