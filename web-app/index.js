const os = require('os')
const dns = require('dns').promises
const { program: optionparser } = require('commander')
const { Kafka } = require('kafkajs')
const mysqlx = require('@mysql/xdevapi');
const MemcachePlus = require('memcache-plus');
const express = require('express')
const nunjucks  = require('nunjucks');
const app = express()


app.use(express.json())
app.use(express.static('public'));

const cacheTimeSecs = 15

let options = optionparser
	.storeOptionsAsProperties(true)
	// Web server
	.option('--port <port>', "Web server port", 3000)
	// Kafka options
	.option('--kafka-broker <host:port>', "Kafka bootstrap host:port", "my-cluster-kafka-bootstrap:9092")
	.option('--kafka-topic-tracking <topic>', "Kafka topic to tracking data send to", "tracking-data")
	.option('--kafka-topic-case <topic>', "Kafka topic to case data send to", "case-data")
	.option('--kafka-client-id < id > ', "Kafka client ID", "tracker-" + Math.floor(Math.random() * 100000))
	.option('--kafka-client-id2 < id > ', "Kafka client ID", "tracker-" + Math.floor(Math.random() * 100000))
	// Memcached options
	.option('--memcached-hostname <hostname>', 'Memcached hostname (may resolve to multiple IPs)', 'my-memcached-service')
	.option('--memcached-port <port>', 'Memcached port', 11211)
	.option('--memcached-update-interval <ms>', 'Interval to query DNS for memcached IPs', 5000)
	// Database options
	.option('--mysql-host <host>', 'MySQL host', 'my-app-mysql-service')
	.option('--mysql-port <port>', 'MySQL port', 33060)
	.option('--mysql-schema <db>', 'MySQL Schema/database', 'covid')
	.option('--mysql-username <username>', 'MySQL username', 'root')
	.option('--mysql-password <password>', 'MySQL password', 'mysecretpw')
	// Misc
	.addHelpCommand()
	.parse()
	.opts()

let env = nunjucks.configure(['views/'], {
    autoescape: true, 
    express: app
});  

const dbConfig = {
	host: options.mysqlHost,
	port: options.mysqlPort,
	user: options.mysqlUsername,
	password: options.mysqlPassword,
	schema: options.mysqlSchema
};

async function executeQuery(query, data) {
	let session = await mysqlx.getSession(dbConfig);
	return await session.sql(query, data).bind(data).execute()
}

let memcached = null
let memcachedServers = []

async function getMemcachedServersFromDns() {
	try {
		// Query all IP addresses for this hostname
		let queryResult = await dns.lookup(options.memcachedHostname, { all: true })

		// Create IP:Port mappings
		let servers = queryResult.map(el => el.address + ":" + options.memcachedPort)

		// Check if the list of servers has changed
		// and only create a new object if the server list has changed
		if (memcachedServers.sort().toString() !== servers.sort().toString()) {
			console.log("Updated memcached server list to ", servers)
			memcachedServers = servers

			//Disconnect an existing client
			if (memcached)
				await memcached.disconnect()

			memcached = new MemcachePlus(memcachedServers);
		}
	} catch (e) {
		console.log("Unable to get memcache servers", e)
	}
}

getMemcachedServersFromDns()
setInterval(() => getMemcachedServersFromDns(), options.memcachedUpdateInterval)

async function getFromCache(key) {
	if (!memcached) {
		console.log(`No memcached instance available, memcachedServers = ${memcachedServers}`)
		return null;
	}
	return await memcached.get(key);
}

const kafka = new Kafka({
	clientId: options.kafkaClientId,
	brokers: [options.kafkaBroker],
	retry: {
		retries: 0
	}
})

const kafka2 = new Kafka({
	clientId: options.kafkaClientId2,
	brokers: [options.kafkaBroker],
	retry: {
		retries: 0
	}
})

const producer = kafka.producer()
const producer2 = kafka2.producer()

async function sendCaseData(data) {
	await producer2.connect()

	await producer2.send({
		topic: options.kafkaTopicCase,
		messages: [
			{ value: JSON.stringify(data) }
		]
	})
}

async function sendTrackingMessage(data) {
	await producer.connect()

	await producer.send({
		topic: options.kafkaTopicTracking,
		messages: [
			{ value: JSON.stringify(data) }
		]
	})
}

async function getReport(countryCode) {
	const query = "SELECT countryCode, country, flagUrl, description FROM countries WHERE countryCode = ?"
	const queryCases = "SELECT DATE_FORMAT(date, '%Y-%m-%d'), totalCases, curedCases FROM reported_cases WHERE countryCode = ? ORDER BY date"
	const key = 'countryCode_' + countryCode
	let cachedata = await getFromCache(key)

	if (cachedata) {
		console.log(`Cache hit for key=${key}`)
		return { result: cachedata, cached: true }
	} else {
		console.log(`Cache miss for key=${key}, querying database`)

		let dataCountry = (await executeQuery(query, [countryCode])).fetchOne()
		let dataCase = (await executeQuery(queryCases, [countryCode])).fetchAll().map(
			row =>  ({
				date: row[0],
				cases: row[1],
				cured: row[2]
			})
		)
		let totalCured = 0, totalCases = 0;
		for (i = 0; i < dataCase.length; i++) {
			totalCases += dataCase[i].cases
			totalCured += dataCase[i].cured
		}
		if (dataCountry) {
			let result = { 
				countryCode: dataCountry[0], 
				country: dataCountry[1], 
				flagUrl: dataCountry[2], 
				description: dataCountry[3], 
				totalCases: totalCases, 
				curedCases: totalCured
			}
			result = {...result, caseData: dataCase}
			console.log(`Got result, storing in cache`)
			if (memcached)
				await memcached.set(key, result, cacheTimeSecs);
			return { result: result, cached: false }
		} else {
			throw "No data found for this country"
		}
	}
}

async function getcountries() {
	const key = 'countries'
	let cachedata = await getFromCache(key)

	if (cachedata) {
		console.log(`Cache hit for key=${key}`)
		return { result: cachedata, cached: true }
	} else {
		console.log(`Cache miss for key=${key}, querying database`)
		let executeResult = await executeQuery("SELECT countryCode, country, flagUrl, description FROM countries ORDER BY countryCode", [])
		let data = executeResult.fetchAll()
		if (data) {
			let result = data.map(row => ({
				 countryCode: row[0], 
				 country: row[1], 
				 flagUrl: row[2], 
				 description: row[3] 
			}))
			console.log(`Got result, storing in cache`)
			if (memcached)
				await memcached.set(key, result, cacheTimeSecs);
			return { result, cached: false }
		} else {
			throw "No countires found"
		}
	}
}

async function getTopTenCountries(type) {
	let query = "SELECT country, flagUrl FROM most_popular_country LEFT JOIN countries ON most_popular_country.countryCode=countries.countryCode ORDER BY count LIMIT 10"
	if(type==="cases")
	{
		query = "SELECT country, flagUrl, (SUM(totalCases)) AS TOTAL FROM reported_cases LEFT JOIN countries ON reported_cases.countryCode=countries.countryCode GROUP BY countries.countryCode ORDER BY TOTAL DESC LIMIT 10"
	}
	return (await executeQuery(query, []))
		.fetchAll().map(row =>  ({ country: row[0], flagUrl: row[1], totalCases: row[2]}) )
}

function sendResponse(res, htmlpart, data) {
	let view = {
		osHostname: os.hostname(),
		date: new Date(),
		memcachedServer: memcachedServers,
		memcachedServers: memcachedServers.length,
        htmlpart: htmlpart
	  };
	
    res.render('layout.html', {...view, ...data})
}

app.get("/", (req, res) => {
    Promise.all([getcountries(), getTopTenCountries("ten")]).then(values => {
        const countries = values[0].result
		const topTen = values[1]
        
        let data = {
			topTenTitle: "Die 10 meistbesuchten Länder",
            countries: countries,
            topTen: topTen,
            cachedResult: values[0].cached
        }

		sendResponse(res, "topCases", data)
	})

})

app.get("/report/order/:type", (req, res) => {
	const type = req.params["type"];
    Promise.all([getcountries(), getTopTenCountries(type)]).then(values => {
        const countries = values[0].result
		const topTen = values[1]
        
        let data = {
			topTenTitle: type!=="cases" ? "Die 10 meistbesuchten Länder" : "Die 10 Länder mit den meisten Fällen",
            countries: countries,
            topTen: topTen,
            cachedResult: values[0].cached
        }
		sendResponse(res, "topCases", data)
	})
})

app.get("/report/:countryCode", (req, res) => {
	const countryCode = req.params["countryCode"].toUpperCase();
    sendTrackingMessage({
		countryCode: countryCode,
		timestamp: Math.floor(new Date() / 1000)
	}).then(() => console.log("Sent to kafka"))
		.catch(e => console.log("Error sending to kafka", e))
    
	getReport(countryCode).then(data => {
		let viewData = {
			countryCode: data.result.countryCode,
			country: data.result.country,
			flagUrl: data.result.flagUrl,
			description: data.result.description,
			totalCases: data.result.totalCases,
			curedCases: data.result.curedCases,
			cachedResult: data.cached,
			caseData: data.result.caseData
		}
		sendResponse(res, "country", viewData)
	}).catch(err => {
		res.send(`<h1>Error</h1><p>${err}</p>`)
	})

	
});

app.post("/report", (req, res) => {
	let data = req.body

	sendCaseData({ 
		countryCode: data.countryCode,
		timestamp: Math.floor(new Date() / 1000),
        newCases: data.newCases,
        newCuredCases: data.newCuredCases
	}).then(() => console.log("Sent to kafka"))
		.catch(e => console.log("Error sending to kafka", e))

	res.send(`Case data send!`)
});

app.listen(options.port, function () {
	console.log("Node app is running at http://localhost:" + options.port)
});
