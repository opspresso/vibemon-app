"""Generate promtool input using the actual collector expressions."""
import json
from vibemon_collector.prometheus import QUERIES


def fixture():
    series = []
    def add(name, values="1+0x8"):
        series.append({"series": name, "values": values})
    add('node_cpu_seconds_total{instance="a",cpu="0",mode="idle"}', '0+7.5x8')
    add('node_cpu_seconds_total{instance="b",cpu="0",mode="idle"}', '0+15x8')
    for node, total, available, ready in [('a', 100, 50, 1), ('b', 300, 90, 0)]:
        add(f'node_memory_MemTotal_bytes{{instance="{node}"}}', f'{total}+0x8')
        add(f'node_memory_MemAvailable_bytes{{instance="{node}"}}', f'{available}+0x8')
        for replica in ['one', 'two']:
            add(f'kube_node_info{{node="{node}",replica="{replica}"}}')
            add(f'kube_node_status_condition{{node="{node}",condition="Ready",status="true",replica="{replica}"}}', f'{ready}+0x8')
    # Evaluation is at 120s. A pod created at 30s is still starting.
    pods = [('pending', 'Pending', '0', 0, False), ('unready', 'Running', '0', 0, False), ('lost', 'Unknown', '0', 0, False),
            ('healthy', 'Running', '1', 0, False), ('completed', 'Succeeded', '0', 0, False), ('failed', 'Failed', '0', 0, False),
            ('terminating', 'Running', '0', 0, True), ('starting', 'Running', '0', 30, False), ('recovering', 'Running', '1 1 1 1 1 0 0 0 0', 0, False)]
    for pod, active, ready, created, deleting in pods:
        for replica in ['one', 'two']:
            add(f'kube_pod_status_ready{{namespace="demo",pod="{pod}",condition="true",replica="{replica}"}}', ready if ' ' in ready else f'{ready}+0x8')
            add(f'kube_pod_created{{namespace="demo",pod="{pod}",replica="{replica}"}}', f'{created}+0x8')
            if deleting:
                add(f'kube_pod_deletion_timestamp{{namespace="demo",pod="{pod}",replica="{replica}"}}', '100+0x8')
            for phase in ['Pending', 'Failed', 'Unknown', 'Running', 'Succeeded']:
                add(f'kube_pod_status_phase{{namespace="demo",pod="{pod}",phase="{phase}",replica="{replica}"}}', f'{int(phase == active)}+0x8')
    expected = {'cpuPercent': 25, 'memoryPercent': 65, 'nodesReady': 1, 'nodesTotal': 2, 'podsUnhealthy': 3}
    # PromQL rates can differ from exact decimal expectations by several ULPs.
    tests = [{"name": "aggregate unequal hosts, deduplicate KSM replicas, count lost and long-unready pods, exclude finished, terminating and starting pods", "interval": "15s", "input_series": series, "promql_expr_test": [{"expr": f"abs(({expression}) - {expected[key]}) < bool 1e-9", "eval_time": "2m", "exp_samples": [{"labels": "{}", "value": 1}]} for key, expression in QUERIES.items()]}, {"name": "absent exporters are not zero", "interval": "15s", "input_series": [], "promql_expr_test": [{"expr": expression, "eval_time": "2m", "exp_samples": []} for expression in QUERIES.values()]}]
    return {"evaluation_interval": "15s", "tests": tests}

if __name__ == '__main__': print(json.dumps(fixture(), indent=2))
