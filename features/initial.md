Overview
======== 

The project has three directories:
1. zulip/ we have zulip software, which is an instant communications tool written using django, tornado, redis, memcached, postgres and rabbitmq
2. docker-zulip/ we have docker compose for running zulip 
  using docker
3. bombadil/ we have bombadil which is a ui PBT software. I want to use bombadil to test the web version of zulip.

In this initial project the goal is to accomplish a few tasks:
* Spin up a zulip instance with a realm, and 2 users. This is not production and the instance is ephimeral and disposed after the test so please simplify
the security as much a possible
* I'd like to have 2 instances of bombadil, running in separate chromiums, each of them connected to the zulip server using one of the 2 users created
* The bombadil tests should kept running for an amount of time (5 mins by default with the option to change it)

Please bear in mind in a second phase I want to make it run inside antithesis, so try to avoid making any decision that would make that later goal more difficult.