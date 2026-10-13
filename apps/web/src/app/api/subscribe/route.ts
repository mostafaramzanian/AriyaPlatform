// app/api/subscribe/route.ts
import { newsletterFormSchema } from '@/lib/validation';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = newsletterFormSchema.parse(body);

    // TODO: Add to email list (Mailchimp, ConvertKit, etc.)
    // TODO: Store subscription in database
    
    console.log('Newsletter subscription:', validated);

    return NextResponse.json(
      { 
        success: true, 
        message: 'Subscribed successfully. Check your email for confirmation.' 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Newsletter subscription error:', error);
    
    return NextResponse.json(
      { error: 'Failed to subscribe' },
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
