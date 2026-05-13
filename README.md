# ioBroker.windhager-mycomfort

ioBroker adapter for Windhager myComfort cloud heating systems.

## Configuration

Configure the adapter instance in ioBroker Admin:

- myComfort email
- myComfort password
- system ID
- device identifier
- refresh interval in seconds
- read concurrency
- request timeout

The adapter marks `email` and `password` as `protectedNative`, and stores `password`
via `encryptedNative`.

## Object tree

The adapter creates states under its own namespace, for example:

```text
windhager-mycomfort.0
├── info
├── auth
├── settings
└── devices
     ├── biowin_ii
     │   ├── boiler_temp_current_value          r
     │   ├── boiler_output                      r
     │   ├── boiler_temp_setpoint               r
     │   └── ...
     │
     ├── haus_radiator
         ├── room_temperature_current_value     r
         ├── flow_temperature_current_value     r
         ├── room_temperature_setpoint_heating  r/w
         ├── flow_temperature_setpoint          r
         └── operating_mode                     r

```

Device states are created dynamically from the Windhager datapoints returned by
the cloud API. Technical IDs such as `nodeId`, `functionId`, and `oid` are stored
in each state's `native` object.
