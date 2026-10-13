// app/api/book-demo/route.ts
import { bookDemoFormSchema } from '@/lib/validation';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = bookDemoFormSchema.parse(body);

    // TODO: Send confirmation email
    // TODO: Create calendar event
    // TODO: Store in CRM/database
    // TODO: Send to sales team notification
    
    console.log('Demo request:', validated);

    return NextResponse.json(
      { 
        success: true, 
        message: 'Demo request received. We will contact you shortly.' 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Book demo error:', error);
    
    return NextResponse.json(
      { error: 'Failed to process demo request' },
      { status: 400 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
