from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import IntegerType, StringType, StructType, TimestampType
import mysqlx

dbOptions = {"host": "my-app-mysql-service", 'port': 33060, "user": "root", "password": "mysecretpw"}
dbSchema = 'covid'
windowDuration = '5 minutes'
slidingDuration = '1 minute'

spark = SparkSession.builder \
    .appName("Structured Streaming").getOrCreate()

spark.sparkContext.setLogLevel('WARN')

kafkaMessages = spark \
    .readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers",
            "my-cluster-kafka-bootstrap:9092") \
    .option("subscribe", "case-data") \
    .option("startingOffsets", "earliest") \
    .load()

trackingMessageSchema = StructType() \
    .add("countryCode", StringType()) \
    .add("timestamp", IntegerType()) \
    .add("newCases", IntegerType()) \
    .add("newCuredCases", IntegerType())

trackingMessages = kafkaMessages.select(
    from_json(
        col("value").cast("string"), 
        trackingMessageSchema
    ).alias("json")
).select(
    from_unixtime(column('json.timestamp'))
    .cast(TimestampType())
    .alias("parsed_timestamp"),
    column("json.*")
).withColumn("date", to_date(col("parsed_timestamp"))) \
.withColumnRenamed('json.countryCode', 'countryCode') \
.withColumnRenamed('json.newCases', 'countryCode') \
.withColumnRenamed('json.newCuredCases', 'countryCode') \
.withWatermark("parsed_timestamp", windowDuration)


cases = trackingMessages.groupBy(
    window(
        column("parsed_timestamp"),
        windowDuration,
        slidingDuration
    ),
    column("countryCode"),
    column("date")) \
.sum("newCases", "newCuredCases") \
.withColumn("date", col("date").cast("string")) \
.withColumnRenamed("sum(newCases)", "totalCases") \
.withColumnRenamed("sum(newCuredCases)","curedCases")


consoleDump = cases \
    .writeStream \
    .trigger(processingTime=slidingDuration) \
    .outputMode("update") \
    .format("console") \
    .option("truncate", "false") \
    .start()



def saveToDatabase(batchDataframe, batchId):
    def save_to_db(iterator):
        session = mysqlx.get_session(dbOptions)
        session.sql("USE covid").execute()

        for row in iterator:
            sql = session.sql("INSERT INTO reported_cases "
                              "(countryCode, date, totalCases, curedCases) VALUES (?, ?, ?, ?) "
                              "ON DUPLICATE KEY UPDATE totalCases=?, curedCases=?")
            sql.bind(row.countryCode, row.date, row.totalCases, row.curedCases, row.totalCases, row.curedCases).execute()

        session.close()
    batchDataframe.foreachPartition(save_to_db)


dbInsertStream = cases.writeStream \
    .trigger(processingTime=slidingDuration) \
    .outputMode("update") \
    .foreachBatch(saveToDatabase) \
    .start()

spark.streams.awaitAnyTermination()
