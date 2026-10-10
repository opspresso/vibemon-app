# syntax=docker/dockerfile:1
FROM registry.k8s.io/kubectl:v1.36.2@sha256:b0d792e0d8dfb9bb1b922b78b23137e2a34bb6f9667640353a9d2aadd1fd7761 AS kubectl
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY collector/pyproject.toml /build/pyproject.toml
COPY collector/vibemon_collector /build/vibemon_collector
RUN pip install --no-cache-dir 'psutil==7.2.2' /build && rm -rf /build
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 65532:65532
ENTRYPOINT ["vibemon-collector"]
