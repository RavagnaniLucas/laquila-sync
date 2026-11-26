-- Ajustes depois da documentação oficial da Laquila (/docs)
alter table products add column if not exists laquila_active boolean not null default true;
alter table orders add column if not exists label_file text; -- nome do arquivo de etiqueta enviado no 00010
-- Para desfazer:
--   alter table products drop column laquila_active;
--   alter table orders drop column label_file;
