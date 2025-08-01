import { AccountBalanceService } from '@ghostfolio/api/app/account-balance/account-balance.service';
import { PortfolioChangedEvent } from '@ghostfolio/api/events/portfolio-changed.event';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { DATE_FORMAT } from '@ghostfolio/common/helper';
import { Filter } from '@ghostfolio/common/interfaces';

import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Account,
  AccountBalance,
  Order,
  Platform,
  Prisma
} from '@prisma/client';
import { Big } from 'big.js';
import { format } from 'date-fns';
import { groupBy } from 'lodash';

import { CashDetails } from './interfaces/cash-details.interface';

@Injectable()
export class AccountService {
  public constructor(
    private readonly accountBalanceService: AccountBalanceService,
    private readonly eventEmitter: EventEmitter2,
    private readonly exchangeRateDataService: ExchangeRateDataService,
    private readonly prismaService: PrismaService
  ) {}

  public async account({
    id_userId
  }: Prisma.AccountWhereUniqueInput): Promise<Account | null> {
    const [account] = await this.accounts({
      where: id_userId
    });

    return account;
  }

  public async accountWithActivities(
    accountWhereUniqueInput: Prisma.AccountWhereUniqueInput,
    accountInclude: Prisma.AccountInclude
  ): Promise<
    Account & {
      activities?: Order[];
    }
  > {
    return this.prismaService.account.findUnique({
      include: accountInclude,
      where: accountWhereUniqueInput
    });
  }

  public async accounts(params: {
    include?: Prisma.AccountInclude;
    skip?: number;
    take?: number;
    cursor?: Prisma.AccountWhereUniqueInput;
    where?: Prisma.AccountWhereInput;
    orderBy?: Prisma.AccountOrderByWithRelationInput;
  }): Promise<
    (Account & {
      activities?: Order[];
      balances?: AccountBalance[];
      platform?: Platform;
    })[]
  > {
    const { include = {}, skip, take, cursor, where, orderBy } = params;

    const isBalancesIncluded = !!include.balances;

    include.balances = {
      orderBy: { date: 'desc' },
      ...(isBalancesIncluded ? {} : { take: 1 })
    };

    const accounts = await this.prismaService.account.findMany({
      cursor,
      include,
      orderBy,
      skip,
      take,
      where
    });

    return accounts.map((account) => {
      account = { ...account, balance: account.balances[0]?.value ?? 0 };

      if (!isBalancesIncluded) {
        delete account.balances;
      }

      return account;
    });
  }

  public async createAccount(
    data: Prisma.AccountCreateInput,
    aUserId: string
  ): Promise<Account> {
    const account = await this.prismaService.account.create({
      data
    });

    await this.accountBalanceService.createOrUpdateAccountBalance({
      accountId: account.id,
      balance: data.balance,
      date: format(new Date(), DATE_FORMAT),
      userId: aUserId
    });

    this.eventEmitter.emit(
      PortfolioChangedEvent.getName(),
      new PortfolioChangedEvent({
        userId: account.userId
      })
    );

    return account;
  }

  public async deleteAccount(
    where: Prisma.AccountWhereUniqueInput
  ): Promise<Account> {
    const account = await this.prismaService.account.delete({
      where
    });

    this.eventEmitter.emit(
      PortfolioChangedEvent.getName(),
      new PortfolioChangedEvent({
        userId: account.userId
      })
    );

    return account;
  }

  public async getAccounts(aUserId: string): Promise<Account[]> {
    const accounts = await this.accounts({
      include: {
        activities: true,
        platform: true
      },
      orderBy: { name: 'asc' },
      where: { userId: aUserId }
    });

    return accounts.map((account) => {
      let transactionCount = 0;

      for (const { isDraft } of account.activities) {
        if (!isDraft) {
          transactionCount += 1;
        }
      }

      const result = { ...account, transactionCount };

      delete result.activities;

      return result;
    });
  }

  public async getCashDetails({
    currency,
    filters = [],
    userId,
    withExcludedAccounts = false
  }: {
    currency: string;
    filters?: Filter[];
    userId: string;
    withExcludedAccounts?: boolean;
  }): Promise<CashDetails> {
    let totalCashBalanceInBaseCurrency = new Big(0);

    const where: Prisma.AccountWhereInput = {
      userId
    };

    if (withExcludedAccounts === false) {
      where.isExcluded = false;
    }

    const { ACCOUNT: filtersByAccount } = groupBy(filters, ({ type }) => {
      return type;
    });

    if (filtersByAccount?.length > 0) {
      where.id = {
        in: filtersByAccount.map(({ id }) => {
          return id;
        })
      };
    }

    const accounts = await this.accounts({ where });

    for (const account of accounts) {
      totalCashBalanceInBaseCurrency = totalCashBalanceInBaseCurrency.plus(
        this.exchangeRateDataService.toCurrency(
          account.balance,
          account.currency,
          currency
        )
      );
    }

    return {
      accounts,
      balanceInBaseCurrency: totalCashBalanceInBaseCurrency.toNumber()
    };
  }

  public async updateAccount(
    params: {
      where: Prisma.AccountWhereUniqueInput;
      data: Prisma.AccountUpdateInput;
    },
    aUserId: string
  ): Promise<Account> {
    const { data, where } = params;

    await this.accountBalanceService.createOrUpdateAccountBalance({
      accountId: data.id as string,
      balance: data.balance as number,
      date: format(new Date(), DATE_FORMAT),
      userId: aUserId
    });

    const account = await this.prismaService.account.update({
      data,
      where
    });

    this.eventEmitter.emit(
      PortfolioChangedEvent.getName(),
      new PortfolioChangedEvent({
        userId: account.userId
      })
    );

    return account;
  }

  public async updateAccountBalance({
    accountId,
    amount,
    currency,
    date = new Date(),
    userId
  }: {
    accountId: string;
    amount: number;
    currency: string;
    date?: Date;
    userId: string;
  }) {
    const { balance, currency: currencyOfAccount } = await this.account({
      id_userId: {
        userId,
        id: accountId
      }
    });

    const amountInCurrencyOfAccount =
      await this.exchangeRateDataService.toCurrencyAtDate(
        amount,
        currency,
        currencyOfAccount,
        date
      );

    if (amountInCurrencyOfAccount) {
      await this.accountBalanceService.createOrUpdateAccountBalance({
        accountId,
        userId,
        balance: new Big(balance).plus(amountInCurrencyOfAccount).toNumber(),
        date: date.toISOString()
      });
    }
  }
}
