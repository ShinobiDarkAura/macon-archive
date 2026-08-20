-- remove the smoke-test record left by verifying the enquiry webhook
delete from public.inquiries where email = 'webhook-test@example.com';
