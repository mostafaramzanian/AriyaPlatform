import t from '@/lib/i18n';

export function HeroSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden border-b border-border/70 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.16),_transparent_35%),linear-gradient(135deg,_rgba(2,132,199,0.02),_rgba(15,23,42,0.02))] py-20 sm:py-24 lg:py-28">
      <div className="container-shell relative">
        <div className="mx-auto max-w-4xl text-center">
          <div className="eyebrow mb-4">{t('eyebrow.platform')}</div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            {title}
          </h1>
          {description && (
            <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
              {description}
            </p>
          )}
          {children && <div className="mt-8 flex flex-col justify-center gap-4 sm:flex-row">{children}</div>}
        </div>
      </div>
    </section>
  );
}

export function FeatureGrid({
  features,
}: {
  features: Array<{
    icon?: React.ReactNode;
    title: string;
    description: string;
  }>;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      {features.map((feature, index) => (
        <div key={index} className="card-panel p-8 transition duration-200 hover:-translate-y-1 hover:shadow-soft">
          {feature.icon && <div className="mb-5 inline-flex rounded-2xl bg-surface-muted p-3 text-primary">{feature.icon}</div>}
          <h3 className="text-lg font-semibold text-foreground">{feature.title}</h3>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">{feature.description}</p>
        </div>
      ))}
    </div>
  );
}

export function CTASection({
  title,
  description,
  primaryButtonText,
  primaryButtonHref,
  secondaryButtonText,
  secondaryButtonHref,
}: {
  title: string;
  description: string;
  primaryButtonText: string;
  primaryButtonHref: string;
  secondaryButtonText?: string;
  secondaryButtonHref?: string;
}) {
  return (
    <section className="section-shell">
      <div className="container-shell">
        <div className="card-panel overflow-hidden bg-primary px-8 py-12 text-primary-foreground sm:px-12 lg:px-16">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
            <p className="mt-5 text-lg leading-8 text-primary-foreground/85">{description}</p>
            <div className="mt-8 flex flex-col justify-center gap-4 sm:flex-row">
              <a href={primaryButtonHref} className="btn-secondary border-transparent bg-surface text-primary">
                {t(primaryButtonText)}
              </a>
              {secondaryButtonText && secondaryButtonHref && (
                <a href={secondaryButtonHref} className="rounded-full border border-primary-foreground/30 px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary-foreground/10">
                  {t(secondaryButtonText)}
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
