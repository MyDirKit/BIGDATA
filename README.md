# Use Case: Basic Covid Reporter

# Popular JSON
```json
{ 
	countryCode: 'DE', 
	timestamp: 1604325221 
}
```

# Cases JSON
```json
{
	countryCode: 'DE', 
	timestamp: 1604325221,
	newCases: 20,
	newCuredCases: 21
}
```

## Overview
# Landing Page
[Display](/sceenshots/LandingPage.png?raw=true "Top Ten Cases")

# Architecture
[Display](/sceenshots/architecture.png?raw=true "Architecture")


## Prerequisites

A running Strimzi.io Kafka operator

```bash
helm repo add strimzi http://strimzi.io/charts/
helm install my-kafka-operator strimzi/strimzi-kafka-operator
kubectl apply -f https://farberg.de/talks/big-data/code/helm-kafka-operator/kafka-cluster-def.yaml
```

A running Hadoop cluster with YARN (for checkpointing)

```bash
helm repo add stable https://charts.helm.sh/stable
helm install --namespace=default --set hdfs.dataNode.replicas=1 --set yarn.nodeManager.replicas=1 --set hdfs.webhdfs.enabled=true my-hadoop-cluster stable/hadoop
```

## Deploy

To develop using [Skaffold](https://skaffold.dev/), use `skaffold dev`. 
