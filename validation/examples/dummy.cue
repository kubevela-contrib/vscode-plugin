"my-name": {
	attributes: {
		workload: {
			type: "autodetects.core.oam.dev"
		}
		status: {
			healthPolicy: #"""
				lastCondition: context.output.status.conditions[0]
				isHealth: (lastCondition.type == "Ready") && (lastCondition.status == "True")
				"""#

			customStatus: #"""
					lastCondition: context.output.status.conditions[0]
					if lastCondition.type == "Ready" {
						message: "DB: \(lastCondition.reason)"
					}
					if lastCondition.type != "Ready" {
						message: "DB: \(lastCondition.type) - \(lastCondition.reason)"
					}
				"""#
		}
		podDisruptive: true
	}
	description: "database instance"
	type:        "componen"
}
template: {
	output: {

	}
	// parameter: {

	// }
}
