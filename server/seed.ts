import { db } from './db';
import { users } from '@shared/schema';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

async function seed() {
  console.log('🌱 Seeding database with demo data...');

  try {
    // Create demo users
    const demoUsers = [
      {
        id: randomUUID(),
        name: 'Admin User',
        email: 'admin@bluecarbon.com',
        password: await bcrypt.hash('admin123', 12),
        role: 'admin',
        username: 'admin',
      },
      {
        id: randomUUID(),
        name: 'Verifier One',
        email: 'verifier1@bluecarbon.com',
        password: await bcrypt.hash('verifier123', 12),
        role: 'verifier',
        username: 'verifier1',
      },
      {
        id: randomUUID(),
        name: 'Alice Johnson',
        email: 'alice@bluecarbon.com',
        password: await bcrypt.hash('password123', 12),
        role: 'contributor',
        username: 'alice',
      },
      {
        id: randomUUID(),
        name: 'Bob Smith',
        email: 'bob@bluecarbon.com',
        password: await bcrypt.hash('password123', 12),
        role: 'contributor',
        username: 'bob',
      },
    ];

    for (const user of demoUsers) {
      await db.insert(users).values(user as any).onConflictDoNothing();
      console.log(`✅ Created user: ${user.email}`);
    }

    console.log('✅ Database seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
}

seed();
