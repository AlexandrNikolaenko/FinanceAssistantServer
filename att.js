const { TinkoffInvestApi } = require('tinkoff-invest-api')

const api = new TinkoffInvestApi({
  token: 't.msuX0bIsBLdObuoILQ0Ps66rv2ljYAEh8Dv1EQEX-oSAria3hWegliysRyMxicExZVEU3zzf-li5EISd0j3Chg',
})

async function main() {
  const res = await api.users.getAccounts({
    status: 'ACCOUNT_STATUS_OPEN',
  })

  console.log(res.accounts)
}

main().catch(console.error)