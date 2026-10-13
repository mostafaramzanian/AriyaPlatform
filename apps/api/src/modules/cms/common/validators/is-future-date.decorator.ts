import { registerDecorator, ValidationOptions } from 'class-validator';

export function IsFutureDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isFutureDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: string) {
          if (typeof value !== 'string') {
            return false;
          }
          const parsed = new Date(value);
          return !Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now();
        },
        defaultMessage() {
          return '$property must be a valid future ISO8601 date';
        },
      },
    });
  };
}
