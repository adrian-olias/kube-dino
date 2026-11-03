# Distroless Node: no shell, no package manager, runs as user 65532.
# No npm install: the app has no dependencies.
FROM gcr.io/distroless/nodejs22-debian12:nonroot

# Lets fetch trust the cluster's CA when calling the Kubernetes API.
ENV NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

WORKDIR /app
COPY package.json ./
COPY src/ ./src/

EXPOSE 8080
CMD ["src/server.js"]
