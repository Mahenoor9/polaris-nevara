import redis
from rq import Worker, Queue, Connection
from config import settings
import logging

# Configure worker logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("mrv-worker")

listen = ['default']

# Redis connection setup
conn = redis.from_url(settings.REDIS_URL)

if __name__ == '__main__':
    logger.info("🚀 MRV Worker starting up...")
    with Connection(conn):
        worker = Worker(list(map(Queue, listen)))
        worker.work()
