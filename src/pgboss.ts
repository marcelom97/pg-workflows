import PgBoss from 'pg-boss';

let bossInstance: PgBoss | undefined;

export async function getBoss(): Promise<PgBoss> {
  if (!bossInstance) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    bossInstance = new PgBoss({
      application_name: 'feather-workflow',
      connectionString: databaseUrl,
    });

    bossInstance.on('error', (error) => {
      console.error('PgBoss error:', error);
    });

    if (process.env.NODE_ENV !== 'test') {
      await bossInstance.start();
    }
  }

  return bossInstance;
}
